// Package summary computes history summaries (REQ-14.0.2, 14.0.3; design
// D16), mirroring plugin/core/history/summarize.ts: each main-conversation
// request's outcome against the one before it, re-cache spend by cause, and
// the avoidable share. Computed when read, from the records the mod wrote.
package summary

import (
	"regexp"
	"sort"
	"strconv"

	"github.com/coreyx/claude-token-shield/internal/cost"
	"github.com/coreyx/claude-token-shield/internal/data"
	"github.com/coreyx/claude-token-shield/internal/native"
)

// SessionHistory is one session's history as read from its chunks.
type SessionHistory struct {
	SessionID string           `json:"sessionId"`
	Requests  []native.Request `json:"requests"`
	Events    []native.Event   `json:"events"`
	// Assessments are the calibration pairs recorded before main requests.
	Assessments []AssessmentRecord `json:"assessments,omitempty"`
	// Skipped counts chunks that couldn't be read or are from a newer format.
	Skipped int `json:"skipped"`
}

// Causes are the causes in the order the summary lists them.
var Causes = []string{"ttl_expiry", "switch", "tools", "compaction", "server_side", "unexplained"}

// Range is a time window, epoch ms, inclusive.
type Range struct {
	From float64 `json:"from"`
	To   float64 `json:"to"`
}

// Filter picks one session or all, and whether to list only re-caches.
type Filter struct {
	Session string
	Misses  bool
}

// Row is one main request after the first of its session.
type Row struct {
	Session       string   `json:"session"`
	Ts            float64  `json:"ts"`
	Model         string   `json:"model"`
	TTL           *string  `json:"ttl"`
	Outcome       string   `json:"outcome"`
	Cause         *string  `json:"cause"`
	RecacheTokens float64  `json:"recacheTokens"`
	RecacheUSD    *float64 `json:"recacheUsd"`
	Avoidable     bool     `json:"avoidable"`
	GapSec        float64  `json:"gapSec"`
}

// CauseTotal is the spend and count for one cause.
type CauseTotal struct {
	Count  int     `json:"count"`
	Tokens float64 `json:"tokens"`
	USD    float64 `json:"usd"`
}

// Summary is a summary over a window.
type Summary struct {
	Range          Range                  `json:"range"`
	Sessions       int                    `json:"sessions"`
	Requests       int                    `json:"requests"`
	Recaches       int                    `json:"recaches"`
	RecacheTokens  float64                `json:"recacheTokens"`
	RecacheUSD     float64                `json:"recacheUsd"`
	Unpriced       int                    `json:"unpriced"`
	ByCause        map[string]*CauseTotal `json:"byCause"`
	AvoidableCount int                    `json:"avoidableCount"`
	AvoidableUSD   float64                `json:"avoidableUsd"`
	Rows           []Row                  `json:"rows"`
	SkippedChunks  int                    `json:"skippedChunks"`
}

var ttlSec = map[string]float64{"5m": 300, "1h": 3600}

// actionCauses are events the person causes that rebuild the cache.
var actionCauses = map[string]string{
	"model_switch": "switch", "effort_change": "switch", "fast_toggle": "switch",
	"mcp_plugin_toggle": "tools", "reload_plugins": "tools", "image_batch_removal": "tools",
	"compaction": "compaction",
}

// nativeCauses are Claude Code's own diagnoses of a miss.
var nativeCauses = map[string]string{
	"ttl_expired_5m": "ttl_expiry", "ttl_expired_1h": "ttl_expiry", "model_changed": "switch",
	"tools_changed": "tools", "system_prompt_changed": "tools", "likely_server_side": "server_side",
}

// Claude Code stamps a diagnosed miss with the time of the request that
// missed, so a diagnosis belongs to a request from its start (less a second
// of clock skew) to a minute after it ends.
const (
	nativeBeforeMs = 1_000
	nativeAfterMs  = 60_000
)

// Classify reads at least 95% of the prefix as a hit, at most 5% as a miss,
// anything between as partial (design D12; the probe's rule).
func Classify(read, prefix float64) string {
	if prefix <= 0 {
		if read > 0 {
			return "HIT"
		}
		return "MISS"
	}
	share := read / prefix
	switch {
	case share >= 0.95:
		return "HIT"
	case share <= 0.05:
		return "MISS"
	}
	return "PARTIAL"
}

func windowTokens(r native.Request) float64 {
	u := r.Usage
	return u.Input + u.Read + u.Write5m + u.Write1h + u.Output
}

// attribute puts one re-cache down to a cause: an action since the previous
// request first, then Claude Code's diagnosis, then the gap against the TTL.
func attribute(events []native.Event, prev, r native.Request, ttl string) (string, *float64) {
	for _, e := range events {
		if c, ok := actionCauses[e.Kind]; ok && e.Ts > prev.TsStart && e.Ts <= r.TsStart {
			at := e.Ts
			return c, &at
		}
	}
	dur := 0.0
	if r.DurationMs != nil {
		dur = *r.DurationMs
	}
	end := r.TsStart + dur + nativeAfterMs
	for _, e := range events {
		if e.Kind != "native_miss" || e.Ts < r.TsStart-nativeBeforeMs || e.Ts > end || e.Detail == nil {
			continue
		}
		if c, ok := nativeCauses[e.Detail.To]; ok {
			return c, nil
		}
	}
	if ttl != "" && (r.TsStart-prev.TsStart)/1000 > ttlSec[ttl] {
		return "ttl_expiry", nil
	}
	return "unexplained", nil
}

// Summarize summarizes the history in a window (REQ-14.0.2, 14.0.3, AC 6.5).
func Summarize(sessions []SessionHistory, rng Range, f Filter, p *data.Prices, provider string) Summary {
	s := Summary{Range: rng, ByCause: map[string]*CauseTotal{}, Rows: []Row{}}
	for _, c := range Causes {
		s.ByCause[c] = &CauseTotal{}
	}
	seen := map[string]bool{}
	for _, h := range sessions {
		if f.Session != "" && h.SessionID != f.Session {
			continue
		}
		s.SkippedChunks += h.Skipped
		main := []native.Request{}
		for _, r := range h.Requests {
			if r.Lane == "main" {
				main = append(main, r)
			}
		}
		sort.SliceStable(main, func(a, b int) bool { return main[a].TsStart < main[b].TsStart })
		events := append([]native.Event{}, h.Events...)
		sort.SliceStable(events, func(a, b int) bool { return events[a].Ts < events[b].Ts })
		for i, r := range main {
			if r.TsStart < rng.From || r.TsStart > rng.To {
				continue
			}
			s.Requests++
			seen[h.SessionID] = true
			if i == 0 {
				continue
			}
			prev := main[i-1]
			ttl := prev.TTL
			if ttl == "" {
				ttl = r.TTL
			}
			var ttlPtr *string
			if ttl != "" {
				v := ttl
				ttlPtr = &v
			}
			prefix := windowTokens(prev)
			outcome := Classify(r.Usage.Read, prefix)
			gap := (r.TsStart - prev.TsStart) / 1000
			if outcome == "HIT" {
				if !f.Misses {
					zero := 0.0
					s.Rows = append(s.Rows, Row{Session: h.SessionID, Ts: r.TsStart, Model: r.Model, TTL: ttlPtr, Outcome: outcome, RecacheUSD: &zero, GapSec: gap})
				}
				continue
			}
			missing := prefix - r.Usage.Read
			if missing < 0 {
				missing = 0
			}
			priceTTL := ttl
			if priceTTL == "" {
				priceTTL = "5m"
			}
			priced := cost.NextTurnCost(cost.Input{PrefixTokens: missing, Model: r.Model, TTL: priceTTL, Provider: provider, At: r.TsStart}, p)
			var usd *float64
			if priced.USD != nil {
				v := priced.USD.Cold - priced.USD.Warm
				usd = &v
			}
			cause, actionAt := attribute(events, prev, r, ttl)
			avoidable := false
			if t, ok := ttlSec[ttl]; ok {
				avoidable = (cause == "ttl_expiry" && gap <= 2*t) || (actionAt != nil && (*actionAt-prev.TsStart)/1000 < t)
			}
			s.Recaches++
			s.RecacheTokens += missing
			total := s.ByCause[cause]
			total.Count++
			total.Tokens += missing
			if usd == nil {
				s.Unpriced++
			} else {
				s.RecacheUSD += *usd
				total.USD += *usd
			}
			if avoidable {
				s.AvoidableCount++
				if usd != nil {
					s.AvoidableUSD += *usd
				}
			}
			c := cause
			s.Rows = append(s.Rows, Row{Session: h.SessionID, Ts: r.TsStart, Model: r.Model, TTL: ttlPtr, Outcome: outcome, Cause: &c, RecacheTokens: missing, RecacheUSD: usd, Avoidable: avoidable, GapSec: gap})
		}
	}
	sort.SliceStable(s.Rows, func(a, b int) bool { return s.Rows[a].Ts < s.Rows[b].Ts })
	s.Sessions = len(seen)
	return s
}

var sincePattern = regexp.MustCompile(`^(\d+)([dh])$`)

// SinceRange reads `--since <n>d|<n>h` into a window ending now; 30 days
// without one. ok is false when the argument doesn't parse.
func SinceRange(since string, now float64) (Range, bool) {
	if since == "" {
		return Range{From: now - 30*86_400_000, To: now}, true
	}
	m := sincePattern.FindStringSubmatch(since)
	if m == nil {
		return Range{}, false
	}
	n, err := strconv.Atoi(m[1])
	if err != nil || n <= 0 {
		return Range{}, false
	}
	unit := 3_600_000.0
	if m[2] == "d" {
		unit = 86_400_000
	}
	return Range{From: now - float64(n)*unit, To: now}, true
}
