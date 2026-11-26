package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/coreyx/claude-token-shield/internal/history"
	"github.com/coreyx/claude-token-shield/internal/native"
)

// transcriptLine is one assistant line of a synthetic transcript.
func transcriptLine(session, request, ts string, read, write float64) string {
	b, _ := json.Marshal(map[string]any{
		"type": "assistant", "timestamp": ts, "sessionId": session, "requestId": request,
		"message": map[string]any{"model": "claude-opus-5-5", "content": []any{map[string]string{"type": "text", "text": "made-up reply text"}},
			"usage": map[string]any{"input_tokens": 10, "output_tokens": 500, "cache_read_input_tokens": read, "cache_creation_input_tokens": write,
				"cache_creation": map[string]any{"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": write}}},
	})
	return string(b) + "\n"
}

// TestBackfillBaselinePruneForget runs the store commands end to end:
// backfill reports coverage, history shows the baseline, prune drops old
// history, and forget needs --yes and then leaves nothing (AC 14.6).
func TestBackfillBaselinePruneForget(t *testing.T) {
	home, config := t.TempDir(), t.TempDir()
	vars := map[string]string{"TOKEN_SHIELD_HOME": home, "CLAUDE_CONFIG_DIR": config, "COLUMNS": "120"}
	now := time.Date(2026, 1, 31, 12, 0, 0, 0, time.UTC)
	at := func(daysAgo, min int) string {
		return now.Add(-time.Duration(daysAgo)*24*time.Hour + time.Duration(min)*time.Minute).Format(time.RFC3339)
	}
	_ = os.MkdirAll(filepath.Join(config, "projects", "example"), 0o755)
	transcript := transcriptLine("old-1", "a", at(40, 0), 0, 800000) + transcriptLine("old-1", "b", at(40, 70), 0, 800000)
	_ = os.WriteFile(filepath.Join(config, "projects", "example", "old-1.jsonl"), []byte(transcript), 0o644)

	env, out, _ := testEnv(vars)
	env.Now = func() time.Time { return now }
	if code := Run([]string{"backfill"}, env); code != ExitOK || !strings.Contains(out.String(), "read 1 transcripts: 2 requests from 1 sessions; 0 lines unreadable (100.0% coverage)") {
		t.Fatalf("backfill: exit %d\n%s", code, out.String())
	}

	// The mod's own history since the install: one avoidable re-cache.
	mod := func(ts time.Time, read, write float64) native.Request {
		return native.Request{ID: ts.String(), Lane: "main", TsStart: float64(ts.UnixMilli()), TsStartTier: native.Measured, Model: "claude-opus-5-5", Speed: "standard", TTL: "1h",
			Usage: native.RequestUsage{Input: 10, Read: read, Write1h: write, Output: 500}, Source: "mod"}
	}
	start := now.Add(-5 * 24 * time.Hour)
	reqs := []native.Request{mod(start, 802500, 2000), mod(start.Add(70*time.Minute), 0, 802500)}
	c := history.Chunk{V: history.Version, SessionID: "new-1"}
	for i := range reqs {
		c.Records = append(c.Records, history.Record{Type: "request", Request: &reqs[i]})
	}
	_ = history.WriteChunk(filepath.Join(home, "history"), c)
	env2, out2, _ := testEnv(vars)
	env2.Now = env.Now
	if code := Run([]string{"history", "--all"}, env2); code != ExitOK || !strings.Contains(out2.String(), "Baseline        $") || !strings.Contains(out2.String(), "/week since") {
		t.Errorf("history: exit %d\n%s", code, out2.String())
	}

	// prune: history older than historyDays goes, newer stays.
	oldDir := filepath.Join(home, "history", "ancient")
	_ = history.WriteChunk(filepath.Join(home, "history"), history.Chunk{V: history.Version, SessionID: "ancient"})
	old := now.Add(-200 * 24 * time.Hour)
	_ = os.Chtimes(filepath.Join(oldDir, "000000.json"), old, old)
	env3, out3, _ := testEnv(vars)
	env3.Now = env.Now
	if code := Run([]string{"prune"}, env3); code != ExitOK || !strings.Contains(out3.String(), "removed 1 sessions of history older than 90 days") {
		t.Errorf("prune: exit %d\n%s", code, out3.String())
	}
	if _, err := os.Stat(oldDir); !os.IsNotExist(err) {
		t.Errorf("old history kept")
	}

	// forget: refuses without --yes, then deletes history, sessions and backfill.
	env4, _, errOut := testEnv(vars)
	if code := Run([]string{"forget"}, env4); code != ExitUsage || !strings.Contains(errOut.String(), "--yes") {
		t.Errorf("forget without --yes: exit %d", code)
	}
	_ = os.MkdirAll(filepath.Join(home, "sessions", "new-1"), 0o755)
	env5, out5, _ := testEnv(vars)
	if code := Run([]string{"forget", "--yes", "--json"}, env5); code != ExitOK || !strings.Contains(out5.String(), `"forgotten":true`) {
		t.Errorf("forget: exit %d\n%s", code, out5.String())
	}
	for _, dir := range []string{"history", "sessions", "backfill"} {
		if _, err := os.Stat(filepath.Join(home, dir)); !os.IsNotExist(err) {
			t.Errorf("%s survives forget", dir)
		}
	}
	for _, bad := range [][]string{{"backfill", "--x"}, {"prune", "--x"}, {"forget", "--x"}} {
		env, _, _ := testEnv(vars)
		if code := Run(bad, env); code != ExitUsage {
			t.Errorf("%v: exit %d", bad, code)
		}
	}
}
