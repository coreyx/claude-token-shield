// Package history reads the per-session history chunks the mod writes
// (design.md D16): history/<session>/<seq>.json, each
// {v, session_id, seq, records: [{type, ...}]}. Readers skip record types
// they don't know and chunks with a newer major version, so an older
// tshield keeps working beside a newer mod.
package history

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"

	"github.com/coreyx/claude-token-shield/internal/native"
	"github.com/coreyx/claude-token-shield/internal/store"
	"github.com/coreyx/claude-token-shield/internal/summary"
)

// Version is the chunk format this reader understands.
const Version = 1

// Record is one history record; Type says which field is set.
type Record struct {
	Type    string          `json:"type"`
	Request *native.Request `json:"request,omitempty"`
	Event   *native.Event   `json:"event,omitempty"`
	// Assessment is the assessment that preceded a main request, with its outcome.
	Assessment *summary.AssessmentRecord `json:"assessment,omitempty"`
	// Recommendation and Lever are the advice report's records.
	Recommendation *summary.RecommendationRecord `json:"recommendation,omitempty"`
	Lever          *summary.LeverTakenRecord     `json:"lever,omitempty"`
}

// Chunk is one history file.
type Chunk struct {
	V         int      `json:"v"`
	SessionID string   `json:"session_id"`
	Seq       int      `json:"seq"`
	Records   []Record `json:"records"`
}

// Session is what a session's history holds for assessment.
type Session struct {
	Requests []native.Request
	Events   []native.Event
	// Assessments are the calibration pairs, for calibration.
	Assessments []summary.AssessmentRecord
	// Recommendations and Levers are the advice report's records.
	Recommendations []summary.RecommendationRecord
	Levers          []summary.LeverTakenRecord
	// Skipped counts chunks that couldn't be read or are from a newer format.
	Skipped int
}

// ReadSession reads every chunk of one session in seq order.
func ReadSession(historyDir, sessionID string) Session {
	var s Session
	files, _ := filepath.Glob(filepath.Join(historyDir, sessionID, "*.json"))
	chunks := []Chunk{}
	for _, f := range files {
		raw, err := store.ReadFile(f)
		if err != nil {
			s.Skipped++
			continue
		}
		var c Chunk
		if json.Unmarshal(raw, &c) != nil || c.V > Version {
			s.Skipped++
			continue
		}
		chunks = append(chunks, c)
	}
	sort.Slice(chunks, func(a, b int) bool { return chunks[a].Seq < chunks[b].Seq })
	for _, c := range chunks {
		for _, r := range c.Records {
			switch {
			case r.Type == "request" && r.Request != nil:
				s.Requests = append(s.Requests, *r.Request)
			case r.Type == "event" && r.Event != nil:
				s.Events = append(s.Events, *r.Event)
			case r.Type == "assessment" && r.Assessment != nil:
				s.Assessments = append(s.Assessments, *r.Assessment)
			case r.Type == "recommendation" && r.Recommendation != nil:
				s.Recommendations = append(s.Recommendations, *r.Recommendation)
			case r.Type == "lever_taken" && r.Lever != nil:
				s.Levers = append(s.Levers, *r.Lever)
			}
		}
	}
	return s
}

// Facts orders a session's requests and events by time, as the mod saw them.
func (s Session) Facts() []native.Fact {
	type timed struct {
		ts float64
		f  native.Fact
	}
	all := make([]timed, 0, len(s.Requests)+len(s.Events))
	for i := range s.Requests {
		r := s.Requests[i]
		all = append(all, timed{r.TsStart, native.Fact{Request: &r}})
	}
	for i := range s.Events {
		e := s.Events[i]
		all = append(all, timed{e.Ts, native.Fact{Event: &e}})
	}
	sort.SliceStable(all, func(a, b int) bool { return all[a].ts < all[b].ts })
	facts := make([]native.Fact, len(all))
	for i, t := range all {
		facts[i] = t.f
	}
	return facts
}

// WriteChunk writes a chunk; the mod does this in TypeScript, and tests and
// backfill use this Go form of the same format.
func WriteChunk(historyDir string, c Chunk) error {
	b, err := json.Marshal(c)
	if err != nil {
		return err
	}
	return store.WriteAtomic(filepath.Join(historyDir, c.SessionID, chunkName(c.Seq)), b)
}

// chunkName is a chunk's file name, zero-padded so names sort by seq.
func chunkName(seq int) string {
	n := []byte("000000")
	for i := len(n) - 1; i >= 0 && seq > 0; i-- {
		n[i] = byte('0' + seq%10)
		seq /= 10
	}
	return string(n) + ".json"
}

// Exists reports whether a session has any history.
func Exists(historyDir, sessionID string) bool {
	_, err := os.Stat(filepath.Join(historyDir, sessionID))
	return err == nil
}
