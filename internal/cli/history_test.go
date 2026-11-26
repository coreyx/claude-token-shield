package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coreyx/claude-token-shield/internal/history"
	"github.com/coreyx/claude-token-shield/internal/summary"
)

// historyFixture is one fixtures/history/*.json file.
type historyFixture struct {
	Name     string                   `json:"name"`
	Now      float64                  `json:"now"`
	Since    string                   `json:"since"`
	Session  string                   `json:"session"`
	Misses   bool                     `json:"misses"`
	Provider string                   `json:"provider"`
	Sessions []summary.SessionHistory `json:"sessions"`
	Expect   struct {
		Summary any `json:"summary"`
		Advice  any `json:"advice"`
	} `json:"expect"`
}

// layHistory writes each fixture session as a chunk, as the mod would.
func layHistory(t *testing.T, home string, f historyFixture) {
	t.Helper()
	for _, s := range f.Sessions {
		c := history.Chunk{V: history.Version, SessionID: s.SessionID}
		for i := range s.Requests {
			c.Records = append(c.Records, history.Record{Type: "request", Request: &s.Requests[i]})
		}
		for i := range s.Events {
			c.Records = append(c.Records, history.Record{Type: "event", Event: &s.Events[i]})
		}
		for i := range s.Recommendations {
			c.Records = append(c.Records, history.Record{Type: "recommendation", Recommendation: &s.Recommendations[i]})
		}
		for i := range s.Levers {
			c.Records = append(c.Records, history.Record{Type: "lever_taken", Lever: &s.Levers[i]})
		}
		if err := history.WriteChunk(filepath.Join(home, "history"), c); err != nil {
			t.Fatal(err)
		}
	}
}

// TestHistoryMatchesFixtures runs tshield history --json over every history
// fixture's chunks on disk: the same summary as the core (AC 14.1, 14.2, 6.5).
func TestHistoryMatchesFixtures(t *testing.T) {
	files, _ := filepath.Glob("../../fixtures/history/*.json")
	if len(files) == 0 {
		t.Fatal("no history fixtures")
	}
	for _, file := range files {
		raw, _ := os.ReadFile(file)
		var f historyFixture
		if err := json.Unmarshal(raw, &f); err != nil {
			t.Fatal(err)
		}
		t.Run(f.Name, func(t *testing.T) {
			// Skipped chunks are a property of reading; these fixtures lay readable ones only.
			for i := range f.Sessions {
				if f.Sessions[i].Skipped > 0 {
					t.Skip("skipped-chunk counts are tested on their own")
				}
			}
			home := t.TempDir()
			layHistory(t, home, f)
			vars := map[string]string{"TOKEN_SHIELD_HOME": home}
			if f.Provider == "bedrock" {
				vars["CLAUDE_CODE_USE_BEDROCK"] = "1"
			}
			env, out, errOut := testEnv(vars)
			env.Now = func() time.Time { return time.UnixMilli(int64(f.Now)) }
			args := []string{"history", "--json"}
			if f.Session != "" {
				args = append(args, "--session", f.Session)
			} else {
				args = append(args, "--all")
			}
			if f.Since != "" {
				args = append(args, "--since", f.Since)
			}
			if f.Misses {
				args = append(args, "--misses")
			}
			if code := Run(args, env); code != ExitOK {
				t.Fatalf("exit %d: %s", code, errOut.String())
			}
			var got map[string]any
			_ = json.Unmarshal(out.Bytes(), &got)
			advice := got["advice"]
			delete(got, "advice")
			delete(got, "baseline")
			if d := diffJSON("summary", f.Expect.Summary, any(got)); d != "" {
				t.Errorf("summary differs from the core's: %s", d)
			}
			if d := diffJSON("advice", f.Expect.Advice, advice); d != "" {
				t.Errorf("advice differs from the core's: %s", d)
			}
		})
	}
}

// TestHistoryText prints the summary, counts unreadable and newer-format
// chunks in the footer, and rejects bad options.
func TestHistoryText(t *testing.T) {
	raw, _ := os.ReadFile("../../fixtures/history/gap-70m-avoidable.json")
	var f historyFixture
	_ = json.Unmarshal(raw, &f)
	home := t.TempDir()
	layHistory(t, home, f)
	dir := filepath.Join(home, "history", f.Sessions[0].SessionID)
	_ = os.WriteFile(filepath.Join(dir, "000001.json"), []byte("{not json"), 0o644)
	_ = os.WriteFile(filepath.Join(dir, "000002.json"), []byte(`{"v":99,"records":[]}`), 0o644)
	env, out, _ := testEnv(map[string]string{"TOKEN_SHIELD_HOME": home, "COLUMNS": "100"})
	env.Now = func() time.Time { return time.UnixMilli(int64(f.Now)) }
	env.TzOffsetMin = func() int { return 0 }
	if code := Run([]string{"history"}, env); code != ExitOK {
		t.Fatalf("exit %d", code)
	}
	text := out.String()
	for _, want := range []string{"History  ", "TTL expiry", "avoidable", "2 history chunks skipped"} {
		if !strings.Contains(text, want) {
			t.Errorf("missing %q in:\n%s", want, text)
		}
	}
	for _, bad := range [][]string{{"history", "--since", "soon"}, {"history", "--all", "--session", "x"}, {"history", "--since"}, {"history", "--bogus"}} {
		env, _, _ := testEnv(map[string]string{"TOKEN_SHIELD_HOME": home})
		if code := Run(bad, env); code != ExitUsage {
			t.Errorf("%v: exit %d, want %d", bad, code, ExitUsage)
		}
	}
	// No history at all is a summary of nothing, not an error.
	empty, out2, _ := testEnv(map[string]string{"TOKEN_SHIELD_HOME": t.TempDir()})
	if code := Run([]string{"history"}, empty); code != ExitOK || !strings.Contains(out2.String(), "No main-conversation requests") {
		t.Errorf("empty: exit %d\n%s", code, out2.String())
	}
}

// TestCalibrationCommand reads recorded predictions from every session's
// chunks: the same calibration as the core, with one drift line (AC 14.3, 14.4).
func TestCalibrationCommand(t *testing.T) {
	raw, _ := os.ReadFile("../../fixtures/calibration/hot-drift.json")
	var f struct {
		Records []summary.AssessmentRecord `json:"records"`
		Expect  struct {
			Calibration any `json:"calibration"`
		} `json:"expect"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	// Split across two sessions: calibration spans them all.
	for i, id := range []string{"aaaaaaaa-0000-0000-0000-000000000000", "bbbbbbbb-0000-0000-0000-000000000000"} {
		c := history.Chunk{V: history.Version, SessionID: id}
		for j := i; j < len(f.Records); j += 2 {
			c.Records = append(c.Records, history.Record{Type: "assessment", Assessment: &f.Records[j]})
		}
		if err := history.WriteChunk(filepath.Join(home, "history"), c); err != nil {
			t.Fatal(err)
		}
	}
	latest := 0.0
	for _, r := range f.Records {
		if r.Ts > latest {
			latest = r.Ts
		}
	}
	at := time.UnixMilli(int64(latest) + 60_000)
	env, out, _ := testEnv(map[string]string{"TOKEN_SHIELD_HOME": home})
	env.Now = func() time.Time { return at }
	if code := Run([]string{"calibration", "--json"}, env); code != ExitOK {
		t.Fatalf("exit %d", code)
	}
	var got any
	_ = json.Unmarshal(out.Bytes(), &got)
	if d := diffJSON("calibration", f.Expect.Calibration, got); d != "" {
		t.Errorf("calibration differs from the core's: %s", d)
	}
	env2, out2, _ := testEnv(map[string]string{"TOKEN_SHIELD_HOME": home, "COLUMNS": "100"})
	env2.Now = func() time.Time { return at }
	if code := Run([]string{"history", "--calibration"}, env2); code != ExitOK {
		t.Fatalf("history --calibration: exit %d", code)
	}
	if n := strings.Count(out2.String(), "Drift: HOT misses"); n != 1 {
		t.Errorf("drift lines %d in:\n%s", n, out2.String())
	}
	for _, bad := range [][]string{{"calibration", "--since", "x"}, {"calibration", "--since"}, {"calibration", "--what"}} {
		env, _, _ := testEnv(map[string]string{"TOKEN_SHIELD_HOME": home})
		if code := Run(bad, env); code != ExitUsage {
			t.Errorf("%v: exit %d", bad, code)
		}
	}
}

// TestTTLCommand gives the core's advice from chunks on disk, and how to apply it (AC 16.1, 16.2).
func TestTTLCommand(t *testing.T) {
	raw, _ := os.ReadFile("../../fixtures/ttl/api-1h-wins.json")
	var f struct {
		Now      float64                  `json:"now"`
		Sessions []summary.SessionHistory `json:"sessions"`
		Expect   struct {
			Advice any `json:"advice"`
		} `json:"expect"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	for _, s := range f.Sessions {
		c := history.Chunk{V: history.Version, SessionID: s.SessionID}
		for i := range s.Requests {
			c.Records = append(c.Records, history.Record{Type: "request", Request: &s.Requests[i]})
		}
		if err := history.WriteChunk(filepath.Join(home, "history"), c); err != nil {
			t.Fatal(err)
		}
	}
	env, out, _ := testEnv(map[string]string{"TOKEN_SHIELD_HOME": home})
	env.Now = func() time.Time { return time.UnixMilli(int64(f.Now)) }
	if code := Run([]string{"ttl", "--json"}, env); code != ExitOK {
		t.Fatalf("exit %d", code)
	}
	var got any
	_ = json.Unmarshal(out.Bytes(), &got)
	if d := diffJSON("advice", f.Expect.Advice, got); d != "" {
		t.Errorf("advice differs from the core's: %s", d)
	}
	env2, out2, _ := testEnv(map[string]string{"TOKEN_SHIELD_HOME": home, "COLUMNS": "100"})
	env2.Now = env.Now
	if code := Run([]string{"ttl"}, env2); code != ExitOK || !strings.Contains(out2.String(), "To apply: /cache-check ttl 1h in Claude Code.") {
		t.Errorf("text: exit %d\n%s", code, out2.String())
	}
	empty, out3, _ := testEnv(map[string]string{"TOKEN_SHIELD_HOME": t.TempDir()})
	if code := Run([]string{"ttl"}, empty); code != ExitOK || !strings.Contains(out3.String(), "not enough data yet") {
		t.Errorf("empty: exit %d\n%s", code, out3.String())
	}
	for _, bad := range [][]string{{"ttl", "--since", "x"}, {"ttl", "--since"}, {"ttl", "--what"}} {
		env, _, _ := testEnv(map[string]string{"TOKEN_SHIELD_HOME": home})
		if code := Run(bad, env); code != ExitUsage {
			t.Errorf("%v: exit %d", bad, code)
		}
	}
}
