package summary

import (
	"math"
	"sort"

	"github.com/coreyx/claude-token-shield/internal/cost"
	"github.com/coreyx/claude-token-shield/internal/data"
	"github.com/coreyx/claude-token-shield/internal/native"
)

// MinSessions and MinGaps are the history a bucket needs before it recommends (design D16).
const (
	MinSessions = 10
	MinGaps     = 20
)

// GapCounts are idle gaps by length.
type GapCounts struct {
	Under5m int `json:"under5m"`
	Under1h int `json:"under1h"`
	Over1h  int `json:"over1h"`
}

// TTLBucket is what one bucket's gaps would have cost under each TTL
// (plugin/core/history/ttl.ts).
type TTLBucket struct {
	Sessions    int       `json:"sessions"`
	Gaps        GapCounts `json:"gaps"`
	GapCount    int       `json:"gapCount"`
	Cost5mUSD   *float64  `json:"cost5mUsd"`
	Cost1hUSD   *float64  `json:"cost1hUsd"`
	Recommended *string   `json:"recommended"`
	SavingsUSD  *float64  `json:"savingsUsd"`
}

// TTLAdvice is the advice for the main conversation and for subagents.
type TTLAdvice struct {
	Range    Range     `json:"range"`
	Main     TTLBucket `json:"main"`
	Subagent TTLBucket `json:"subagent"`
}

func ttlBucket(lanes [][]native.Request, p *data.Prices, provider string) TTLBucket {
	var b TTLBucket
	c5, c1, priced5, priced1 := 0.0, 0.0, true, true
	for _, requests := range lanes {
		if len(requests) < 2 {
			continue
		}
		b.Sessions++
		for i := 1; i < len(requests); i++ {
			prev, r := requests[i-1], requests[i]
			gap := (r.TsStart - prev.TsStart) / 1000
			b.GapCount++
			switch {
			case gap <= 300:
				b.Gaps.Under5m++
			case gap <= 3600:
				b.Gaps.Under1h++
			default:
				b.Gaps.Over1h++
			}
			prefix := windowTokens(prev)
			fresh := r.Usage.Write5m + r.Usage.Write1h
			// Under each TTL: the prefix read if the gap fits it, rewritten if not, plus this turn's new writes at that TTL's rate.
			price := func(ttl string, fits bool) (float64, bool) {
				pr := cost.NextTurnCost(cost.Input{PrefixTokens: prefix, Model: r.Model, TTL: ttl, Provider: provider, At: r.TsStart}, p)
				w := cost.NextTurnCost(cost.Input{PrefixTokens: fresh, Model: r.Model, TTL: ttl, Provider: provider, At: r.TsStart}, p)
				if pr.USD == nil || w.USD == nil {
					return 0, false
				}
				if fits {
					return pr.USD.Warm + w.USD.Cold, true
				}
				return pr.USD.Cold + w.USD.Cold, true
			}
			v5, ok5 := price("5m", gap <= 300)
			v1, ok1 := price("1h", gap <= 3600)
			priced5 = priced5 && ok5
			priced1 = priced1 && ok1
			c5 += v5
			c1 += v1
		}
	}
	if priced5 {
		b.Cost5mUSD = &c5
	}
	if priced1 {
		b.Cost1hUSD = &c1
	}
	if b.Sessions >= MinSessions && b.GapCount >= MinGaps && priced5 && priced1 {
		rec := "5m"
		if c1 < c5 {
			rec = "1h"
		}
		s := math.Abs(c5 - c1)
		b.Recommended, b.SavingsUSD = &rec, &s
	}
	return b
}

// AdviseTTL compares the recorded idle gaps' re-cache costs under both TTLs (REQ-16).
func AdviseTTL(sessions []SessionHistory, rng Range, p *data.Prices, provider string) TTLAdvice {
	lane := func(name string) [][]native.Request {
		out := make([][]native.Request, 0, len(sessions))
		for _, s := range sessions {
			rs := []native.Request{}
			for _, r := range s.Requests {
				if r.Lane == name && r.TsStart >= rng.From && r.TsStart <= rng.To {
					rs = append(rs, r)
				}
			}
			sort.SliceStable(rs, func(a, b int) bool { return rs[a].TsStart < rs[b].TsStart })
			out = append(out, rs)
		}
		return out
	}
	return TTLAdvice{Range: rng, Main: ttlBucket(lane("main"), p, provider), Subagent: ttlBucket(lane("subagent"), p, provider)}
}
