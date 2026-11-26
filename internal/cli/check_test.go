package cli

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coreyx/claude-token-shield/internal/bridge"
	"github.com/coreyx/claude-token-shield/internal/history"
	"github.com/coreyx/claude-token-shield/internal/native"
	"github.com/coreyx/claude-token-shield/internal/schemacheck"
)

// fixture is the part of a parity case tshield check needs.
type fixture struct {
	Name  string  `json:"name"`
	Now   float64 `json:"now"`
	Facts []struct {
		Kind       string          `json:"kind"`
		ReceivedAt float64         `json:"receivedAt"`
		Payload    map[string]any  `json:"payload"`
		Request    *native.Request `json:"request"`
		Event      *native.Event   `json:"event"`
	} `json:"facts"`
	Env struct {
		Provider string `json:"provider"`
	} `json:"env"`
	Mode   string `json:"mode"`
	Expect struct {
		View     any `json:"view"`
		ExitCode int `json:"exitCode"`
	} `json:"expect"`
}

const fixtureSession = "11111111-2222-3333-4444-555555555555"

// lay writes a fixture's snapshot and history into a data directory, as the
// bridge and the mod would.
func lay(t *testing.T, home string, f fixture) {
	t.Helper()
	chunk := history.Chunk{V: 1, SessionID: fixtureSession}
	for _, fact := range f.Facts {
		switch fact.Kind {
		case "snapshot":
			snap := native.ParseSnapshotMap(fact.Payload, fact.ReceivedAt)
			b, _ := json.Marshal(bridge.File{V: 1, ReceivedAt: fact.ReceivedAt, Payload: native.Payload(snap)})
			dir := filepath.Join(home, "sessions", fixtureSession)
			_ = os.MkdirAll(dir, 0o755)
			if err := os.WriteFile(filepath.Join(dir, "snapshot.json"), b, 0o644); err != nil {
				t.Fatal(err)
			}
		case "request":
			chunk.Records = append(chunk.Records, history.Record{Type: "request", Request: fact.Request})
		case "event":
			chunk.Records = append(chunk.Records, history.Record{Type: "event", Event: fact.Event})
		}
	}
	if len(chunk.Records) > 0 {
		if err := history.WriteChunk(filepath.Join(home, "history"), chunk); err != nil {
			t.Fatal(err)
		}
	}
}

// TestCheckMatchesParity runs tshield check over every parity fixture: the
// JSON view, exit code and schema all hold (AC 19.1, 19.2).
func TestCheckMatchesParity(t *testing.T) {
	schema, err := os.ReadFile("../../schemas/check.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	files, _ := filepath.Glob("../../fixtures/parity/*.json")
	if len(files) == 0 {
		t.Fatal("no parity fixtures")
	}
	for _, file := range files {
		raw, _ := os.ReadFile(file)
		var f fixture
		if err := json.Unmarshal(raw, &f); err != nil {
			t.Fatal(err)
		}
		t.Run(f.Name, func(t *testing.T) {
			// A resume reaches only the mod, through classic.SessionStart; the CLI
			// reads files and never sees one. The core parity test covers it.
			for _, fact := range f.Facts {
				if fact.Kind == "resume" {
					t.Skip("resume facts reach the mod only")
				}
			}
			home := t.TempDir()
			lay(t, home, f)
			env, out, _ := testEnv(map[string]string{"TOKEN_SHIELD_HOME": home, "CLAUDE_CODE_USE_BEDROCK": map[bool]string{true: "1"}[f.Env.Provider == "bedrock"]})
			env.Now = func() time.Time { return time.UnixMilli(int64(f.Now)) }
			args := []string{"check", "--json", "--session", fixtureSession}
			if f.Mode != "default" {
				args = append(args, "--"+f.Mode)
			}
			code := Run(args, env)
			if code != f.Expect.ExitCode {
				t.Errorf("exit %d, want %d", code, f.Expect.ExitCode)
			}
			problems, err := schemacheck.Validate(schema, out.Bytes())
			if err != nil || len(problems) > 0 {
				t.Errorf("schema: %v %v", err, problems)
			}
			var got any
			_ = json.Unmarshal(out.Bytes(), &got)
			if d := diffJSON("view", f.Expect.View, got); d != "" {
				t.Errorf("view differs from the core's: %s", d)
			}
		})
	}
}

// TestCheckText renders text, names the CLI's blind spot in verbose output, and finds the newest session.
func TestCheckText(t *testing.T) {
	raw, _ := os.ReadFile("../../fixtures/parity/hot-api.json")
	var f fixture
	_ = json.Unmarshal(raw, &f)
	home := t.TempDir()
	lay(t, home, f)
	env, out, _ := testEnv(map[string]string{"TOKEN_SHIELD_HOME": home, "COLUMNS": "100"})
	env.Now = func() time.Time { return time.UnixMilli(int64(f.Now)) }
	env.TzOffsetMin = func() int { return 0 }
	if code := Run([]string{"check", "--verbose"}, env); code != 0 {
		t.Fatalf("exit %d", code)
	}
	text := out.String()
	if !strings.HasPrefix(text, "Cache  HOT") || !strings.Contains(text, "Timeline (main conversation)") || !strings.Contains(text, "events the mod sees live") {
		t.Errorf("verbose text:\n%s", text)
	}
}

// TestCheckProbeMakesNoRequest explains the probe needs the mod (AC 7.4).
func TestCheckProbeMakesNoRequest(t *testing.T) {
	env, out, _ := testEnv(map[string]string{"TOKEN_SHIELD_HOME": t.TempDir()})
	if code := Run([]string{"check", "--probe"}, env); code != ExitUsage || !strings.Contains(out.String(), "needs the Token Shield mod") {
		t.Errorf("probe: %d %q", code, out)
	}
	env, out, _ = testEnv(map[string]string{"TOKEN_SHIELD_HOME": t.TempDir()})
	Run([]string{"check", "--probe", "--json"}, env)
	if !strings.Contains(out.String(), `"error"`) {
		t.Errorf("probe json: %q", out)
	}
}

// TestCheckWithoutData reports UNKNOWN and points at setup.
func TestCheckWithoutData(t *testing.T) {
	env, out, errOut := testEnv(map[string]string{"TOKEN_SHIELD_HOME": t.TempDir()})
	if code := Run([]string{"check"}, env); code != 50 || !strings.Contains(out.String(), "UNKNOWN") || !strings.Contains(errOut.String(), "setup") {
		t.Errorf("no data: exit %d\n%s\n%s", code, out, errOut)
	}
	for _, bad := range [][]string{{"check", "--session"}, {"check", "--frobnicate"}} {
		env, _, _ := testEnv(nil)
		if Run(bad, env) != ExitUsage {
			t.Errorf("%v should be a usage error", bad)
		}
	}
}

// diffJSON reports the first difference between decoded JSON values, allowing float noise.
func diffJSON(path string, want, got any) string {
	switch w := want.(type) {
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok {
			return path + ": not an object"
		}
		for k := range w {
			if d := diffJSON(path+"."+k, w[k], g[k]); d != "" {
				return d
			}
		}
		for k := range g {
			if _, ok := w[k]; !ok {
				return path + "." + k + ": unexpected"
			}
		}
	case []any:
		g, ok := got.([]any)
		if !ok || len(g) != len(w) {
			return fmt.Sprintf("%s: want %d items", path, len(w))
		}
		for i := range w {
			if d := diffJSON(fmt.Sprintf("%s[%d]", path, i), w[i], g[i]); d != "" {
				return d
			}
		}
	case float64:
		g, ok := got.(float64)
		if !ok || math.Abs(w-g) > 1e-9*math.Max(1, math.Abs(w)) {
			return fmt.Sprintf("%s: want %v, got %v", path, w, got)
		}
	default:
		if fmt.Sprint(want) != fmt.Sprint(got) {
			return fmt.Sprintf("%s: want %v, got %v", path, want, got)
		}
	}
	return ""
}
