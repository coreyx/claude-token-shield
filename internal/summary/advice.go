package summary

import (
	"math"
	"sort"

	"github.com/coreyx/claude-token-shield/internal/cost"
	"github.com/coreyx/claude-token-shield/internal/data"
	"github.com/coreyx/claude-token-shield/internal/native"
)

// StoredQuote is one lever's quote as stored with the recommendation (AC 4.5).
type StoredQuote struct {
	Lever      string   `json:"lever"`
	NowUSD     *float64 `json:"nowUsd"`
	PerTurnUSD *float64 `json:"perTurnUsd"`
}

// RecommendationRecord is a recommendation as shown, with every alternative
// (plugin/core/history/advice.ts).
type RecommendationRecord struct {
	Ts       float64       `json:"ts"`
	State    string        `json:"state"`
	Lever    string        `json:"lever"`
	PHit     *float64      `json:"pHit"`
	ReadUSD  *float64      `json:"readUsd"`
	WriteUSD *float64      `json:"writeUsd"`
	Quotes   []StoredQuote `json:"quotes"`
}

// LeverTakenRecord is a lever the person took.
type LeverTakenRecord struct {
	Ts    float64 `json:"ts"`
	Lever string  `json:"lever"`
}

// AdviceReport is the share of recommendations that were cheapest in hindsight.
type AdviceReport struct {
	Evaluated   int      `json:"evaluated"`
	Cheapest    int      `json:"cheapest"`
	Share       *float64 `json:"share"`
	Unevaluated int      `json:"unevaluated"`
}

const (
	takenWindowMs     = 10 * 60_000
	cheapestTolerance = 1.05
	horizonTurns      = 5
)

// comparable are the levers the recommender weighs against each other (recommend.ts COLD_CANDIDATES).
var comparable = map[string]bool{"continue": true, "compact": true, "rewind": true}

var costLanes = map[string]bool{"main": true, "compact": true, "probe": true, "keepalive": true}

// EvaluateAdvice judges every recommendation in hindsight (design D18).
func EvaluateAdvice(recs []RecommendationRecord, taken []LeverTakenRecord, requests []native.Request, p *data.Prices) AdviceReport {
	main := []native.Request{}
	for _, r := range requests {
		if r.Lane == "main" {
			main = append(main, r)
		}
	}
	sort.SliceStable(main, func(a, b int) bool { return main[a].TsStart < main[b].TsStart })
	actions := append([]LeverTakenRecord{}, taken...)
	sort.SliceStable(actions, func(a, b int) bool { return actions[a].Ts < actions[b].Ts })
	ordered := append([]RecommendationRecord{}, recs...)
	sort.SliceStable(ordered, func(a, b int) bool { return ordered[a].Ts < ordered[b].Ts })

	var rep AdviceReport
	for i, rec := range ordered {
		end := rec.Ts + takenWindowMs
		if i+1 < len(ordered) {
			end = math.Min(end, ordered[i+1].Ts)
		}
		for _, r := range main {
			if r.TsStart > rec.Ts {
				end = math.Min(end, r.TsStart)
				break
			}
		}
		var action *LeverTakenRecord
		for j := range actions {
			if actions[j].Ts > rec.Ts && actions[j].Ts <= end {
				action = &actions[j]
				break
			}
		}
		if action == nil {
			rep.Unevaluated++
			continue
		}
		nextAction := math.Inf(1)
		for _, a := range actions {
			if a.Ts > action.Ts {
				nextAction = a.Ts
				break
			}
		}
		after := []native.Request{}
		for _, r := range main {
			if r.TsStart >= action.Ts && r.TsStart < nextAction && len(after) < horizonTurns+1 {
				after = append(after, r)
			}
		}
		if len(after) == 0 {
			rep.Unevaluated++
			continue
		}
		k := float64(len(after))
		last := after[len(after)-1].TsStart
		realized, priced := 0.0, true
		for _, r := range requests {
			if !costLanes[r.Lane] || r.TsStart < action.Ts || r.TsStart > last {
				continue
			}
			usd, ok := cost.RequestUSD(r, p)
			if !ok {
				priced = false
				break
			}
			realized += usd
		}
		first := after[0]
		var read *bool
		for j := len(main) - 1; j >= 0; j-- {
			if main[j].TsStart < first.TsStart {
				v := Classify(first.Usage.Read, windowTokens(main[j])) != "MISS"
				read = &v
				break
			}
		}
		hindsight := map[string]float64{}
		for _, q := range rec.Quotes {
			if q.Lever == action.Lever || q.NowUSD == nil {
				continue
			}
			now := *q.NowUSD
			if q.Lever == "continue" && read != nil && rec.ReadUSD != nil && rec.WriteUSD != nil {
				if *read {
					now = *rec.ReadUSD
				} else {
					now = *rec.WriteUSD
				}
			}
			per := 0.0
			if q.PerTurnUSD != nil {
				per = *q.PerTurnUSD
			}
			hindsight[q.Lever] = now + (k-1)*per
		}
		if priced {
			hindsight[action.Lever] = realized
		}
		recommended := rec.Lever
		if recommended == "none" {
			recommended = "continue"
		}
		mine, ok := hindsight[recommended]
		best := math.Inf(1)
		for lever, usd := range hindsight {
			if lever != recommended && comparable[lever] && usd < best {
				best = usd
			}
		}
		if !ok || math.IsInf(best, 1) {
			rep.Unevaluated++
			continue
		}
		rep.Evaluated++
		if mine <= cheapestTolerance*best {
			rep.Cheapest++
		}
	}
	if rep.Evaluated > 0 {
		v := float64(rep.Cheapest) / float64(rep.Evaluated)
		rep.Share = &v
	}
	return rep
}

// Advice is the report over the same sessions and window as a summary.
func Advice(sessions []SessionHistory, rng Range, f Filter, p *data.Prices) AdviceReport {
	var total AdviceReport
	for _, s := range sessions {
		if f.Session != "" && s.SessionID != f.Session {
			continue
		}
		recs := []RecommendationRecord{}
		for _, r := range s.Recommendations {
			if r.Ts >= rng.From && r.Ts <= rng.To {
				recs = append(recs, r)
			}
		}
		if len(recs) == 0 {
			continue
		}
		r := EvaluateAdvice(recs, s.Levers, s.Requests, p)
		total.Evaluated += r.Evaluated
		total.Cheapest += r.Cheapest
		total.Unevaluated += r.Unevaluated
	}
	if total.Evaluated > 0 {
		v := float64(total.Cheapest) / float64(total.Evaluated)
		total.Share = &v
	}
	return total
}
