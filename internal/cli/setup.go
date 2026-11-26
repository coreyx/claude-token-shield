package cli

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/coreyx/claude-token-shield/internal/store"
	"github.com/coreyx/claude-token-shield/internal/version"
)

// RefreshIntervalSec keeps the bridge running while idle so the snapshot stays
// fresh (design D2; the unit is seconds, spikes.md §4).
const RefreshIntervalSec = 30

// BridgeFile is bridge.json: what setup replaced, so --undo can restore it.
type BridgeFile struct {
	PreviousCommand    string          `json:"previousCommand"`
	PreviousStatusLine json.RawMessage `json:"previousStatusLine,omitempty"`
	InstalledAt        int64           `json:"installedAt"`
	BinVersion         string          `json:"binVersion"`
}

// settingsPath is the user's Claude Code settings file.
func settingsPath(getenv func(string) string) (string, error) {
	if dir := strings.TrimSpace(getenv("CLAUDE_CONFIG_DIR")); dir != "" {
		return filepath.Join(dir, "settings.json"), nil
	}
	home := getenv("HOME")
	if runtime.GOOS == "windows" {
		home = getenv("USERPROFILE")
	}
	if home == "" {
		var err error
		if home, err = os.UserHomeDir(); err != nil {
			return "", err
		}
	}
	return filepath.Join(home, ".claude", "settings.json"), nil
}

// ManagedSettingsPaths are where enterprise-managed settings live; a
// statusLine there overrides the user's, so setup must not pretend to win.
func ManagedSettingsPaths() []string {
	switch runtime.GOOS {
	case "windows":
		return []string{`C:\Program Files\ClaudeCode\managed-settings.json`}
	case "darwin":
		return []string{"/Library/Application Support/ClaudeCode/managed-settings.json"}
	default:
		return []string{"/etc/claude-code/managed-settings.json"}
	}
}

// setup points Claude Code's statusLine at the bridge (design D14), or with
// --undo puts back what was there.
func setup(args []string, env Env) int {
	undo, yes := false, false
	for _, a := range args {
		switch a {
		case "--undo":
			undo = true
		case "--yes":
			yes = true
		default:
			fmt.Fprintf(env.Stderr, "tshield setup: unknown option %q\n", a)
			return ExitUsage
		}
	}
	p, err := ResolvePaths(env.Getenv)
	if err != nil {
		return fail(env, false, err)
	}
	sp, err := settingsPath(env.Getenv)
	if err != nil {
		return fail(env, false, err)
	}
	managed := env.ManagedSettings
	if managed == nil {
		managed = ManagedSettingsPaths()
	}
	for _, m := range managed {
		if raw, err := os.ReadFile(m); err == nil && hasStatusLine(raw) {
			fmt.Fprintf(env.Stdout, "Your organization's managed settings (%s) set statusLine, which overrides yours.\nToken Shield's bridge can't be set up here; nothing was changed.\n", m)
			return ExitError
		}
	}
	lock, err := store.Acquire(filepath.Join(p.DataDir, "setup.lock"), 10*time.Minute, env.Now())
	if err != nil {
		return fail(env, false, fmt.Errorf("another setup is running: %w", err))
	}
	defer lock.Release()

	original, err := readSettings(sp)
	if err != nil {
		return fail(env, false, err)
	}
	doc, err := parseOrdered(original)
	if err != nil {
		return fail(env, false, fmt.Errorf("%s is not a JSON object: %w", sp, err))
	}
	current := doc.get("statusLine")

	var next json.RawMessage
	var bridge *BridgeFile
	if undo {
		b, err := readBridgeFile(p.Bridge)
		if err != nil {
			fmt.Fprintln(env.Stdout, "Token Shield's bridge isn't set up; nothing to undo.")
			return ExitOK
		}
		next = b.PreviousStatusLine
	} else {
		cmd := bridgeCommand(p.Bin)
		next = newStatusLine(current, cmd)
		prev := BridgeFile{PreviousStatusLine: current, InstalledAt: env.Now().UnixMilli(), BinVersion: version.Version}
		if c := commandOf(current); c != "" && !strings.Contains(c, "tshield-statusline") {
			prev.PreviousCommand = c
		} else if old, err := readBridgeFile(p.Bridge); err == nil {
			// Already set up: keep what was there before Token Shield.
			prev.PreviousCommand, prev.PreviousStatusLine = old.PreviousCommand, old.PreviousStatusLine
		}
		bridge = &prev
	}

	fmt.Fprintf(env.Stdout, "Settings file: %s\n  statusLine now: %s\n  statusLine new: %s\n", sp, show(current), show(next))
	if !yes && !confirm(env, "Write this change? [y/N] ") {
		fmt.Fprintln(env.Stdout, "Nothing was changed.")
		return ExitOK
	}
	// Abort if the file changed while the user was deciding.
	if again, err := readSettings(sp); err != nil || sha256.Sum256(again) != sha256.Sum256(original) {
		return fail(env, false, errors.New("the settings file changed since it was shown; run setup again"))
	}

	if !undo {
		exe, err := env.Executable()
		if err != nil {
			return fail(env, false, err)
		}
		if _, err := store.Install(filepath.Dir(exe), p.Bin, BinaryNames(), env.Now()); err != nil {
			return fail(env, false, fmt.Errorf("installing the binaries: %w", err))
		}
		b, _ := json.MarshalIndent(bridge, "", "  ")
		if err := store.WriteAtomic(p.Bridge, b); err != nil {
			return fail(env, false, err)
		}
	}
	doc.set("statusLine", next)
	if err := store.WriteAtomic(sp, doc.render()); err != nil {
		return fail(env, false, err)
	}
	if undo {
		_ = os.Remove(p.Bridge)
		fmt.Fprintln(env.Stdout, "Restored your previous statusLine.")
	} else {
		fmt.Fprintln(env.Stdout, "Token Shield's statusline bridge is set up. Your previous statusline, if any, still shows alongside it.")
	}
	return ExitOK
}

// confirm asks a yes/no question on stdin.
func confirm(env Env, prompt string) bool {
	fmt.Fprint(env.Stdout, prompt)
	if env.Stdin == nil {
		return false
	}
	line, _ := bufio.NewReader(env.Stdin).ReadString('\n')
	a := strings.ToLower(strings.TrimSpace(line))
	return a == "y" || a == "yes"
}

// bridgeCommand is the configured command: the installed bridge, quoted for the shell.
func bridgeCommand(binDir string) string {
	exe := filepath.Join(binDir, BinaryNames()[1])
	if runtime.GOOS == "windows" {
		return `"` + exe + `"`
	}
	return "'" + strings.ReplaceAll(exe, "'", `'\''`) + "'"
}

// newStatusLine is the statusLine object pointing at the bridge, keeping any
// other fields (padding, say) the user had.
func newStatusLine(current json.RawMessage, command string) json.RawMessage {
	fields := map[string]any{}
	if len(current) > 0 {
		_ = json.Unmarshal(current, &fields)
	}
	fields["type"] = "command"
	fields["command"] = command
	fields["refreshInterval"] = RefreshIntervalSec
	b, _ := json.Marshal(fields)
	return b
}

// commandOf reads statusLine.command.
func commandOf(sl json.RawMessage) string {
	var v struct {
		Command string `json:"command"`
	}
	if len(sl) == 0 || json.Unmarshal(sl, &v) != nil {
		return ""
	}
	return v.Command
}

func hasStatusLine(raw []byte) bool {
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil {
		return false
	}
	v, ok := m["statusLine"]
	return ok && string(v) != "null"
}

func show(sl json.RawMessage) string {
	if len(sl) == 0 {
		return "(none)"
	}
	return string(sl)
}

func readSettings(path string) ([]byte, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return []byte("{}"), nil
	}
	return raw, err
}

func readBridgeFile(path string) (BridgeFile, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return BridgeFile{}, err
	}
	var b BridgeFile
	return b, json.Unmarshal(raw, &b)
}

// ordered is a top-level JSON object that keeps its key order, so setup
// changes one key without reshuffling the user's settings file.
type ordered struct {
	keys   []string
	values map[string]json.RawMessage
}

func parseOrdered(raw []byte) (*ordered, error) {
	o := &ordered{values: map[string]json.RawMessage{}}
	dec := json.NewDecoder(bytes.NewReader(raw))
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	if d, ok := tok.(json.Delim); !ok || d != '{' {
		return nil, errors.New("not an object")
	}
	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, _ := kt.(string)
		var v json.RawMessage
		if err := dec.Decode(&v); err != nil {
			return nil, err
		}
		if _, seen := o.values[key]; !seen {
			o.keys = append(o.keys, key)
		}
		o.values[key] = v
	}
	return o, nil
}

func (o *ordered) get(key string) json.RawMessage { return o.values[key] }

// set replaces a key's value, appending it if new; an empty value removes it.
func (o *ordered) set(key string, v json.RawMessage) {
	if len(v) == 0 {
		delete(o.values, key)
		for i, k := range o.keys {
			if k == key {
				o.keys = append(o.keys[:i], o.keys[i+1:]...)
				break
			}
		}
		return
	}
	if _, ok := o.values[key]; !ok {
		o.keys = append(o.keys, key)
	}
	o.values[key] = v
}

// render writes the object with two-space indentation, keys in their order.
func (o *ordered) render() []byte {
	var b bytes.Buffer
	b.WriteString("{")
	for i, k := range o.keys {
		if i > 0 {
			b.WriteString(",")
		}
		key, _ := json.Marshal(k)
		var val bytes.Buffer
		if json.Indent(&val, o.values[k], "  ", "  ") != nil {
			val.Write(o.values[k])
		}
		b.WriteString("\n  ")
		b.Write(key)
		b.WriteString(": ")
		b.Write(val.Bytes())
	}
	if len(o.keys) > 0 {
		b.WriteString("\n")
	}
	b.WriteString("}\n")
	return b.Bytes()
}
