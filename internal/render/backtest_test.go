package render

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/coreyx/claude-token-shield/internal/assess"
	"github.com/coreyx/claude-token-shield/internal/native"
	"github.com/coreyx/claude-token-shield/internal/summary"
)

// backtestSession is one fixtures/sessions/*.json file, written by scripts/gen-sessions.mjs.
type backtestSession struct {
	Name  string    `json:"name"`
	TTL   string    `json:"ttl"`
	Facts []rawFact `json:"facts"`
}

// TestBacktest replays the synthetic sessions through the assessor: before
// each main request it records what the assessor predicted, then the
// request's real outcome, and reports the reliability table and Brier score
// (AC 21.4, design "Testing approach").
func TestBacktest(t *testing.T) {
	d := shared(t)
	files, _ := filepath.Glob("../../fixtures/sessions/*.json")
	if len(files) == 0 {
		t.Fatal("no sessions in fixtures/sessions/; run node scripts/gen-sessions.mjs")
	}
	records := []summary.AssessmentRecord{}
	expected := 0
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		var s backtestSession
		if err := json.Unmarshal(raw, &s); err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		state := native.State{}
		var prev *native.Request
		for _, f := range s.Facts {
			switch f.Kind {
			case "snapshot":
				snap := native.ParseSnapshot(f.Payload, f.ReceivedAt)
				state = native.Reduce(state, native.Fact{Snapshot: &snap})
			case "request":
				r := *f.Request
				if prev != nil {
					expected++
					// The prediction as the gate would have seen it, just before the request.
					ev := Evaluate(state, r.TsStart, Context{Data: d, Env: assess.Env{Provider: "firstParty", ToolSearch: true}, Mode: "default"})
					if a := ev.A; a.PHit != nil && a.Interval != nil {
						ttl := a.TTL.V
						var ttlPtr *string
						if a.TTL.Known() {
							ttlPtr = &ttl
						}
						u := prev.Usage
						records = append(records, summary.AssessmentRecord{
							Ts: r.TsStart, State: a.State, PHit: *a.PHit, Interval: *a.Interval, TTL: ttlPtr,
							RemainingSec: a.RemainingSec, MarginSec: a.MarginSec,
							Outcome: summary.Classify(r.Usage.Read, u.Input+u.Read+u.Write5m+u.Write1h+u.Output),
						})
					}
				}
				state = native.Reduce(state, native.Fact{Request: &r})
				prev = &r
			}
		}
	}
	pr := d.Rules.Priors
	c := summary.Calibrate(records, summary.Priors{EpsWithin: pr.EpsWithin, EpsAfter: pr.EpsAfter, MinCalibrationN: pr.MinCalibrationN})
	t.Logf("backtest over %d sessions:\n%s", len(files), RenderCalibration(c, pr.MinCalibrationN, 100, Options{Glyphs: GlyphSet("unicode"), Strings: &d.Strings, Display: d.Rules.Display}))

	// Every request after a session's first is predicted: none is UNKNOWN once a snapshot exists.
	if c.N != expected {
		t.Errorf("predictions %d, want %d", c.N, expected)
	}
	if c.Brier == nil || *c.Brier > 0.05 {
		t.Errorf("Brier %v, want at most 0.05", c.Brier)
	}
	for _, b := range c.Buckets {
		// A warm, distant expiry must read the cache nearly always; a past one nearly never.
		if b.State == "HOT" && b.Band == "over_10m" && b.N >= 30 && b.Observed < 0.95 {
			t.Errorf("HOT over 10 min observed %.3f over %d", b.Observed, b.N)
		}
		if b.State == "COLD" && b.N >= 10 && b.Observed > 0.05 {
			t.Errorf("COLD observed %.3f over %d", b.Observed, b.N)
		}
	}
}
