package backfill

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/coreyx/claude-token-shield/internal/history"
	"github.com/coreyx/claude-token-shield/internal/store"
)

const secret = "SECRET-PROMPT-TEXT-about-a-made-up-project"

// assistant is one transcript line as Claude Code writes it, with text that must never be recorded.
func assistant(session, request, ts string, read, write1h int) string {
	return `{"type":"assistant","timestamp":"` + ts + `","sessionId":"` + session + `","requestId":"` + request + `","cwd":"/home/example/project","version":"2.1.332","isSidechain":false,` +
		`"message":{"id":"msg_` + request + `","model":"claude-opus-5-5","content":[{"type":"text","text":"` + secret + `"}],` +
		`"usage":{"input_tokens":12,"output_tokens":400,"cache_read_input_tokens":` + itoa(read) + `,"cache_creation_input_tokens":` + itoa(write1h) +
		`,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":` + itoa(write1h) + `}}}}` + "\n"
}

func itoa(n int) string { return strconv.Itoa(n) }

func write(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestBackfillNumbersOnly reads synthetic transcripts into request records
// that hold no text from them, under the data directory (AC 20.3).
func TestBackfillNumbersOnly(t *testing.T) {
	projects, data := t.TempDir(), t.TempDir()
	user := `{"type":"user","timestamp":"2026-01-10T10:00:00Z","sessionId":"aaaa","message":{"role":"user","content":"` + secret + `"}}` + "\n"
	body := user +
		assistant("aaaa", "r1", "2026-01-10T10:00:05Z", 0, 800000) +
		// The same response again, as streamed responses repeat their usage: counted once.
		assistant("aaaa", "r1", "2026-01-10T10:00:05Z", 0, 800000) +
		assistant("aaaa", "r2", "2026-01-10T10:20:05Z", 800000, 3000) +
		"{not json\n" +
		assistant("aaaa", "r3", "2026-01-10T10:21:05Z", 803000, 2000)[:40] // still being written
	write(t, filepath.Join(projects, "example-project", "aaaa.jsonl"), body)
	write(t, filepath.Join(projects, "example-project", "bbbb", "subagents", "agent-1.jsonl"),
		strings.Replace(assistant("bbbb", "s1", "2026-01-11T09:00:00Z", 0, 50000), `"isSidechain":false`, `"isSidechain":true`, 1))

	rep, err := Run(projects, data, time.Unix(1, 0))
	if err != nil {
		t.Fatal(err)
	}
	if rep.Files != 2 || rep.Requests != 3 || rep.Unreadable != 1 || rep.Sessions != 2 {
		t.Errorf("report %+v", rep)
	}
	if rep.Coverage <= 0.8 || rep.Coverage >= 1 {
		t.Errorf("coverage %v", rep.Coverage)
	}
	s := history.ReadSession(filepath.Join(data, "backfill"), "aaaa")
	if len(s.Requests) != 2 || s.Requests[0].Usage.Write1h != 800000 || s.Requests[1].Usage.Read != 800000 || s.Requests[0].TTL != "1h" || s.Requests[0].Source != "transcript" {
		t.Errorf("requests %+v", s.Requests)
	}
	if sub := history.ReadSession(filepath.Join(data, "backfill"), "bbbb"); len(sub.Requests) != 1 || sub.Requests[0].Lane != "subagent" {
		t.Errorf("subagent %+v", sub.Requests)
	}
	// Nothing written holds text or paths from the transcripts.
	_ = filepath.WalkDir(data, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		raw, _ := os.ReadFile(path)
		for _, bad := range []string{secret, "/home/example", "example-project"} {
			if strings.Contains(string(raw), bad) {
				t.Errorf("%s holds %q", path, bad)
			}
		}
		if rel, _ := filepath.Rel(data, path); strings.HasPrefix(rel, "..") {
			t.Errorf("%s is outside the data directory", path)
		}
		return nil
	})

	// Incremental: a second run reads only what was added since.
	f, _ := os.OpenFile(filepath.Join(projects, "example-project", "aaaa.jsonl"), os.O_APPEND|os.O_WRONLY, 0o644)
	_, _ = f.WriteString(assistant("aaaa", "r3", "2026-01-10T10:21:05Z", 803000, 2000)[40:] + assistant("aaaa", "r4", "2026-01-10T11:40:00Z", 0, 805000))
	_ = f.Close()
	again, err := Run(projects, data, time.Unix(2, 0))
	if err != nil {
		t.Fatal(err)
	}
	// r3's line was still being written the first time, so it was left unread; now it is whole, and r4 is new.
	if again.Requests != 2 || again.Lines != 2 || again.Unreadable != 0 {
		t.Errorf("second run %+v", again)
	}
	if got := len(history.ReadSession(filepath.Join(data, "backfill"), "aaaa").Requests); got != 4 {
		t.Errorf("after the second run %d requests, want 4", got)
	}
}

// TestBackfillLock refuses a second run while one holds the lock.
func TestBackfillLock(t *testing.T) {
	data := t.TempDir()
	now := time.Unix(100, 0)
	l, err := store.Acquire(filepath.Join(data, "backfill", ".lock"), lockStale, now)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = l.Release() }()
	if _, err := Run(t.TempDir(), data, now); !errors.Is(err, ErrBusy) {
		t.Errorf("err %v", err)
	}
}

// TestBackfillNothing reads an empty or missing projects folder as full coverage of nothing.
func TestBackfillNothing(t *testing.T) {
	rep, err := Run(filepath.Join(t.TempDir(), "missing"), t.TempDir(), time.Unix(1, 0))
	if err != nil || rep.Requests != 0 || rep.Coverage != 1 {
		t.Errorf("%+v %v", rep, err)
	}
}
