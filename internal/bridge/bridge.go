// Package bridge is tshield-statusline (design.md D14): configured as Claude
// Code's statusLine.command, it records the native prompt-cache data for the
// mod and the CLI, runs the user's previous statusline command, and draws the
// cache segment itself when the mod isn't running.
//
// It fails open (REQ-21.0.3): whatever goes wrong while recording or
// rendering, the wrapped command still runs and the process exits 0, so a
// Token Shield bug never costs the user their statusline.
package bridge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"

	"github.com/coreyx/claude-token-shield/internal/assess"
	"github.com/coreyx/claude-token-shield/internal/data"
	"github.com/coreyx/claude-token-shield/internal/native"
	"github.com/coreyx/claude-token-shield/internal/render"
	"github.com/coreyx/claude-token-shield/internal/store"
)

// Limits from design D14.
const (
	MaxInput       = 1 << 20 // stdin parsed up to 1 MiB
	WrapTimeout    = 300 * time.Millisecond
	RowsMaxBytes   = 2 << 20 // snapshots.jsonl rotates at 2 MiB
	LogMaxBytes    = 256 << 10
	SnapshotFormat = 1
)

// Env is the process environment, injectable for tests.
type Env struct {
	Stdin           io.Reader
	Stdout          io.Writer
	Getenv          func(string) string
	Now             func() time.Time
	TzOffsetMin     func() int
	RunWrapped      func(command string, stdin []byte, timeout time.Duration) ([]byte, error)
	ProviderFromEnv func(getenv func(string) string) string
}

// RealEnv is the running process's environment.
func RealEnv() Env {
	return Env{
		Stdin: os.Stdin, Stdout: os.Stdout, Getenv: os.Getenv, Now: time.Now,
		TzOffsetMin: func() int { _, off := time.Now().Zone(); return off / 60 },
		RunWrapped:  RunShell, ProviderFromEnv: Provider,
	}
}

// File is snapshot.json: the whitelisted payload and when it arrived.
type File struct {
	V          int            `json:"v"`
	ReceivedAt float64        `json:"receivedAt"`
	Payload    map[string]any `json:"payload"`
}

// Row is one snapshots.jsonl line, written when a tracked field changes.
type Row struct {
	V          int                `json:"v"`
	ReceivedAt float64            `json:"receivedAt"`
	TTL        *string            `json:"ttl"`
	Warm       *bool              `json:"warm"`
	Model      *string            `json:"model"`
	Effort     *string            `json:"effort"`
	FastMode   *bool              `json:"fastMode"`
	Version    *string            `json:"version"`
	Misses     *float64           `json:"misses"`
	FiveHour   *native.RateWindow `json:"fiveHour"`
}

// Bridge is bridge.json, written by setup.
type Bridge struct {
	PreviousCommand string `json:"previousCommand"`
}

// Heartbeat is mod-heartbeat.json, written by the mod every 30 s.
type Heartbeat struct {
	Ts float64 `json:"ts"`
}

// Run is one statusline invocation; it always returns 0.
func Run(env Env) int {
	input, _ := io.ReadAll(io.LimitReader(env.Stdin, 8*MaxInput))
	now := env.Now()
	dir, dirErr := store.DataDir(env.Getenv)
	logf := func(format string, args ...any) {
		if dirErr == nil {
			line := fmt.Sprintf("%s bridge: %s", now.UTC().Format(time.RFC3339), fmt.Sprintf(format, args...))
			_ = store.AppendLine(filepath.Join(dir, "logs", "companions.log"), []byte(line), LogMaxBytes)
		}
	}
	if dirErr != nil {
		dir = ""
	}

	var snap *native.Snapshot
	if len(input) <= MaxInput {
		var raw map[string]any
		if err := json.Unmarshal(input, &raw); err == nil {
			s := native.ParseSnapshotMap(raw, float64(now.UnixMilli()))
			snap = &s
		} else if len(bytes.TrimSpace(input)) > 0 {
			logf("stdin is not JSON: %v", err)
		}
	} else {
		logf("stdin over %d bytes; not parsed", MaxInput)
	}

	sessionDir := ""
	if snap != nil && snap.SessionID.Known() && dir != "" {
		sessionDir = filepath.Join(dir, "sessions", snap.SessionID.V)
		if err := record(sessionDir, *snap); err != nil {
			logf("recording the snapshot: %v", err)
		}
	}

	var out bytes.Buffer
	if dir != "" {
		if cmd := previousCommand(dir); cmd != "" {
			if wrapped, err := env.RunWrapped(cmd, input, WrapTimeout); err == nil {
				out.Write(wrapped)
			} else {
				logf("wrapped command: %v", err)
			}
		}
	}

	d, dataErr := data.Load()
	fresh := defaultHeartbeatFresh
	if dataErr == nil {
		fresh = time.Duration(d.Rules.Timing.HeartbeatFreshSec * float64(time.Second))
	} else {
		logf("loading data: %v", dataErr)
	}
	if snap != nil && dataErr == nil && !modAlive(sessionDir, now, fresh) {
		if seg, err := segment(d, *snap, now, dir, env); err == nil {
			if out.Len() > 0 && !bytes.HasSuffix(out.Bytes(), []byte("\n")) {
				out.WriteString("  ")
			}
			out.WriteString(seg)
		} else {
			logf("rendering: %v", err)
		}
	}
	_, _ = env.Stdout.Write(out.Bytes())
	return 0
}

// record writes snapshot.json and appends a row when a tracked field changed.
func record(sessionDir string, s native.Snapshot) error {
	path := filepath.Join(sessionDir, "snapshot.json")
	prevRow, hadPrev := previousRow(path)
	b, err := json.Marshal(File{V: SnapshotFormat, ReceivedAt: s.ReceivedAt, Payload: native.Payload(s)})
	if err != nil {
		return err
	}
	if err := store.WriteAtomic(path, b); err != nil {
		return err
	}
	row := rowOf(s)
	if hadPrev && sameTracked(prevRow, row) {
		return nil
	}
	line, err := json.Marshal(row)
	if err != nil {
		return err
	}
	return store.AppendLine(filepath.Join(sessionDir, "snapshots.jsonl"), line, RowsMaxBytes)
}

// previousRow is the tracked fields of the snapshot being replaced.
func previousRow(path string) (Row, bool) {
	raw, err := store.ReadFile(path)
	if err != nil {
		return Row{}, false
	}
	var f File
	if json.Unmarshal(raw, &f) != nil {
		return Row{}, false
	}
	return rowOf(native.ParseSnapshotMap(f.Payload, f.ReceivedAt)), true
}

// rowOf takes the tracked fields of a snapshot.
func rowOf(s native.Snapshot) Row {
	r := Row{V: SnapshotFormat, ReceivedAt: s.ReceivedAt}
	str := func(v native.Value[string]) *string {
		if !v.Known() {
			return nil
		}
		x := v.V
		return &x
	}
	if s.PromptCache != nil {
		r.TTL = str(s.PromptCache.TTL)
		if s.PromptCache.Warm.Known() {
			w := s.PromptCache.Warm.V
			r.Warm = &w
		}
		if s.PromptCache.Misses.Known() {
			m := s.PromptCache.Misses.V
			r.Misses = &m
		}
	}
	r.Model, r.Effort, r.Version = str(s.Model), str(s.Effort), str(s.CCVersion)
	if s.FastMode.Known() {
		f := s.FastMode.V
		r.FastMode = &f
	}
	if s.FiveHour.Known() {
		w := s.FiveHour.V
		r.FiveHour = &w
	}
	return r
}

// sameTracked compares the fields whose change earns a row (D14).
func sameTracked(a, b Row) bool {
	ja, _ := json.Marshal(Row{TTL: a.TTL, Warm: a.Warm, Model: a.Model, Effort: a.Effort, FastMode: a.FastMode, Version: a.Version, Misses: a.Misses, FiveHour: a.FiveHour})
	jb, _ := json.Marshal(Row{TTL: b.TTL, Warm: b.Warm, Model: b.Model, Effort: b.Effort, FastMode: b.FastMode, Version: b.Version, Misses: b.Misses, FiveHour: b.FiveHour})
	return bytes.Equal(ja, jb)
}

// previousCommand reads the command setup saved, if any.
func previousCommand(dir string) string {
	raw, err := store.ReadFile(filepath.Join(dir, "bridge.json"))
	if err != nil {
		return ""
	}
	var b Bridge
	if json.Unmarshal(raw, &b) != nil {
		return ""
	}
	return b.PreviousCommand
}

// defaultHeartbeatFresh is how recent the mod's heartbeat must be for the mod
// to draw the segment instead, when rules.json can't be read
// (its timing.heartbeatFreshSec is the source).
const defaultHeartbeatFresh = 90 * time.Second

// modAlive reports whether the mod wrote a heartbeat for this session recently.
func modAlive(sessionDir string, now time.Time, fresh time.Duration) bool {
	if sessionDir == "" {
		return false
	}
	raw, err := store.ReadFile(filepath.Join(sessionDir, "mod-heartbeat.json"))
	if err != nil {
		return false
	}
	var h Heartbeat
	if json.Unmarshal(raw, &h) != nil || h.Ts <= 0 {
		return false
	}
	return now.Sub(time.UnixMilli(int64(h.Ts))) <= fresh
}

// segment renders the cache segment from the snapshot alone.
func segment(d *data.Shared, s native.Snapshot, now time.Time, dir string, env Env) (string, error) {
	state := native.Reduce(native.State{}, native.Fact{Snapshot: &s})
	provider := env.ProviderFromEnv(env.Getenv)
	ev := render.Evaluate(state, float64(now.UnixMilli()), render.Context{Data: d, Env: assess.Env{Provider: provider, ToolSearch: true}, Mode: "default"})
	opts := render.Options{Glyphs: render.GlyphSet(glyphStyle(dir)), Strings: &d.Strings, Display: d.Rules.Display, TzOffsetMin: env.TzOffsetMin(), Billing: ev.Billing}
	return render.Segment(ev.A, ev.Cost, opts), nil
}

// glyphStyle reads the configured glyph set from the mod's config mirror.
func glyphStyle(dir string) string {
	if dir == "" {
		return "unicode"
	}
	raw, err := store.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		return "unicode"
	}
	var c struct {
		Glyphs string `json:"glyphs"`
	}
	if json.Unmarshal(raw, &c) != nil || c.Glyphs != "ascii" {
		return "unicode"
	}
	return "ascii"
}

// Provider infers where requests go from Claude Code's documented provider
// switches in the environment.
func Provider(getenv func(string) string) string {
	switch {
	case getenv("CLAUDE_CODE_USE_BEDROCK") == "1":
		return "bedrock"
	case getenv("CLAUDE_CODE_USE_VERTEX") == "1":
		return "vertex"
	case getenv("CLAUDE_CODE_USE_FOUNDRY") == "1":
		return "foundry"
	}
	return "firstParty"
}

// ErrTimeout means the wrapped command ran past its budget.
var ErrTimeout = errors.New("wrapped command timed out")

// RunShell runs a command line through the platform shell with stdin, and
// returns its stdout if it exits 0 within the timeout. Its stderr is dropped.
func RunShell(command string, stdin []byte, timeout time.Duration) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, "cmd", "/C", command)
	} else {
		cmd = exec.CommandContext(ctx, "sh", "-c", command)
	}
	cmd.Stdin = bytes.NewReader(stdin)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.WaitDelay = 50 * time.Millisecond
	err := cmd.Run()
	if ctx.Err() != nil {
		return nil, ErrTimeout
	}
	if err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}
