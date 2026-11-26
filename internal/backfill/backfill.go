// Package backfill builds the pre-install baseline from Claude Code's own
// transcripts (REQ-14.0.8, design D17): numbers only, read incrementally,
// written as request records under the data directory's backfill/ folder.
package backfill

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/coreyx/claude-token-shield/internal/history"
	"github.com/coreyx/claude-token-shield/internal/native"
	"github.com/coreyx/claude-token-shield/internal/store"
)

// Report is what a backfill run read and found.
type Report struct {
	Files      int `json:"files"`
	Lines      int `json:"lines"`
	Requests   int `json:"requests"`
	Unreadable int `json:"unreadable"`
	// Coverage is the share of non-empty lines that parsed, 0–1; 1 with nothing to read.
	Coverage float64 `json:"coverage"`
	Sessions int     `json:"sessions"`
}

// cursors maps a hash of each transcript's path to the bytes already read,
// so the store keeps no project paths.
type cursors struct {
	V     int              `json:"v"`
	Files map[string]int64 `json:"files"`
}

// line holds only the fields a record needs. Decoding into it drops every
// other field, message content included, before anything is built (REQ-20.0.4).
type line struct {
	Type        string `json:"type"`
	Timestamp   string `json:"timestamp"`
	SessionID   string `json:"sessionId"`
	RequestID   string `json:"requestId"`
	IsSidechain bool   `json:"isSidechain"`
	Message     *struct {
		ID    string `json:"id"`
		Model string `json:"model"`
		Usage *struct {
			Input         float64 `json:"input_tokens"`
			Output        float64 `json:"output_tokens"`
			CacheRead     float64 `json:"cache_read_input_tokens"`
			CacheCreation float64 `json:"cache_creation_input_tokens"`
			Split         *struct {
				FiveMin float64 `json:"ephemeral_5m_input_tokens"`
				OneHour float64 `json:"ephemeral_1h_input_tokens"`
			} `json:"cache_creation"`
		} `json:"usage"`
	} `json:"message"`
}

// lockStale is how old a backfill lock must be before another run takes it over.
const lockStale = 10 * time.Minute

// ErrBusy means another backfill holds the lock.
var ErrBusy = errors.New("another backfill is running")

// Run reads every transcript under projectsDir from where the last run
// stopped, and writes the requests it finds to dataDir/backfill/<session>/.
// A line that doesn't parse lowers the coverage; it never fails the run
// (REQ-21.0.4).
func Run(projectsDir, dataDir string, now time.Time) (Report, error) {
	dir := filepath.Join(dataDir, "backfill")
	lock, err := store.Acquire(filepath.Join(dir, ".lock"), lockStale, now)
	if errors.Is(err, store.ErrLocked) {
		return Report{}, ErrBusy
	}
	if err != nil {
		return Report{}, err
	}
	defer func() { _ = lock.Release() }()

	cur := cursors{V: 1, Files: map[string]int64{}}
	if raw, err := store.ReadFile(filepath.Join(dir, "cursor.json")); err == nil {
		_ = json.Unmarshal(raw, &cur)
		if cur.Files == nil {
			cur.Files = map[string]int64{}
		}
	}
	files := transcripts(projectsDir)
	var rep Report
	bySession := map[string][]native.Request{}
	seen := map[string]bool{}
	for _, path := range files {
		key := hash(path)
		read, found, lines, unreadable, err := readFrom(path, cur.Files[key], seen)
		if err != nil {
			rep.Unreadable++
			continue
		}
		rep.Files++
		rep.Lines += lines
		rep.Unreadable += unreadable
		cur.Files[key] = read
		for _, r := range found {
			bySession[r.session] = append(bySession[r.session], r.request)
			rep.Requests++
		}
	}
	ids := make([]string, 0, len(bySession))
	for id := range bySession {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		c := history.Chunk{V: history.Version, SessionID: id, Seq: nextSeq(filepath.Join(dir, id))}
		for i := range bySession[id] {
			c.Records = append(c.Records, history.Record{Type: "request", Request: &bySession[id][i]})
		}
		if err := history.WriteChunk(dir, c); err != nil {
			return rep, err
		}
	}
	rep.Sessions = len(ids)
	b, _ := json.Marshal(cur)
	if err := store.WriteAtomic(filepath.Join(dir, "cursor.json"), b); err != nil {
		return rep, err
	}
	rep.Coverage = 1
	if rep.Lines > 0 {
		rep.Coverage = float64(rep.Lines-rep.Unreadable) / float64(rep.Lines)
	}
	return rep, nil
}

// transcripts lists Claude Code's transcript files under the projects
// folder, subagent transcripts included, in a stable order.
func transcripts(projectsDir string) []string {
	var files []string
	_ = filepath.WalkDir(projectsDir, func(path string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() && filepath.Ext(path) == ".jsonl" {
			files = append(files, path)
		}
		return nil
	})
	sort.Strings(files)
	return files
}

func hash(path string) string {
	sum := sha256.Sum256([]byte(filepath.ToSlash(path)))
	return hex.EncodeToString(sum[:8])
}

type found struct {
	session string
	request native.Request
}

// readFrom reads complete lines from offset on; a partial last line is left
// for the next run. It returns the new offset, the requests found, the
// non-empty lines read and how many of them didn't parse.
func readFrom(path string, offset int64, seen map[string]bool) (int64, []found, int, int, error) {
	f, err := os.Open(path)
	if err != nil {
		return offset, nil, 0, 0, err
	}
	defer f.Close()
	fi, err := f.Stat()
	if err != nil {
		return offset, nil, 0, 0, err
	}
	// A file shorter than the cursor was rewritten: start it over.
	if fi.Size() < offset {
		offset = 0
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return offset, nil, 0, 0, err
	}
	var out []found
	lines, unreadable := 0, 0
	r := bufio.NewReaderSize(f, 1<<20)
	for {
		raw, err := r.ReadBytes('\n')
		if err != nil {
			// No newline yet: the line is still being written.
			break
		}
		offset += int64(len(raw))
		raw = bytes.TrimSpace(raw)
		if len(raw) == 0 {
			continue
		}
		lines++
		var l line
		if json.Unmarshal(raw, &l) != nil {
			unreadable++
			continue
		}
		if req, session, ok := toRequest(l, seen); ok {
			out = append(out, found{session, req})
		}
	}
	return offset, out, lines, unreadable, nil
}

// toRequest builds a request record from one assistant line's numbers. A
// streamed response repeats its usage on several lines; it counts once.
func toRequest(l line, seen map[string]bool) (native.Request, string, bool) {
	if l.Type != "assistant" || l.Message == nil || l.Message.Usage == nil || l.SessionID == "" || l.Message.Model == "" {
		return native.Request{}, "", false
	}
	id := l.RequestID
	if id == "" {
		id = l.Message.ID
	}
	if id == "" || seen[id] {
		return native.Request{}, "", false
	}
	ts, err := time.Parse(time.RFC3339Nano, l.Timestamp)
	if err != nil {
		return native.Request{}, "", false
	}
	seen[id] = true
	u := l.Message.Usage
	w5, w1 := u.CacheCreation, 0.0
	ttl := ""
	if u.Split != nil {
		w5, w1 = u.Split.FiveMin, u.Split.OneHour
	}
	switch {
	case w1 > 0:
		ttl = "1h"
	case w5 > 0:
		ttl = "5m"
	}
	lane := "main"
	if l.IsSidechain {
		lane = "subagent"
	}
	return native.Request{
		ID:          "transcript-" + hash(id),
		Lane:        lane,
		TsStart:     float64(ts.UnixMilli()),
		TsStartTier: native.Inferred,
		Model:       l.Message.Model,
		Speed:       "standard",
		TTL:         ttl,
		Usage:       native.RequestUsage{Input: u.Input, Read: u.CacheRead, Write5m: w5, Write1h: w1, Output: u.Output},
		Source:      "transcript",
	}, l.SessionID, true
}

// nextSeq is the chunk number after the highest already in a session's folder.
func nextSeq(dir string) int {
	files, _ := filepath.Glob(filepath.Join(dir, "*.json"))
	next := 0
	for _, f := range files {
		name := strings.TrimSuffix(filepath.Base(f), ".json")
		if n, err := strconv.Atoi(name); err == nil && n+1 > next {
			next = n + 1
		}
	}
	return next
}
