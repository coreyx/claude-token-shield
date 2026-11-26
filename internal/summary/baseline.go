package summary

import (
	"math"

	"github.com/coreyx/claude-token-shield/internal/data"
)

// BaselineReport is the pre-install baseline beside the current figure
// (plugin/core/history/baseline.ts).
type BaselineReport struct {
	InstallAt         float64 `json:"installAt"`
	Weeks             float64 `json:"weeks"`
	BeforePerWeekUSD  float64 `json:"beforePerWeekUsd"`
	CurrentPerWeekUSD float64 `json:"currentPerWeekUsd"`
}

const weekMs = 7 * 86_400_000

// InstallTime is the earliest request the mod itself wrote; ok is false before it has written any.
func InstallTime(sessions []SessionHistory) (float64, bool) {
	first, ok := 0.0, false
	for _, s := range sessions {
		for _, r := range s.Requests {
			if r.Source == "mod" && (!ok || r.TsStart < first) {
				first, ok = r.TsStart, true
			}
		}
	}
	return first, ok
}

// Baseline is the avoidable spend per week before the install, beside the
// figure since (REQ-14.0.8). Each period counts as at least a week. nil with
// no backfilled request before the install.
func Baseline(backfill []SessionHistory, installAt float64, haveInstall bool, current Summary, p *data.Prices, provider string) *BaselineReport {
	if !haveInstall {
		return nil
	}
	earliest, found := 0.0, false
	for _, s := range backfill {
		for _, r := range s.Requests {
			if r.Lane == "main" && r.TsStart < installAt && (!found || r.TsStart < earliest) {
				earliest, found = r.TsStart, true
			}
		}
	}
	if !found {
		return nil
	}
	before := Summarize(backfill, Range{From: earliest, To: installAt - 1}, Filter{}, p, provider)
	weeks := math.Max(1, (installAt-earliest)/weekMs)
	since := math.Max(1, (current.Range.To-math.Max(current.Range.From, installAt))/weekMs)
	return &BaselineReport{InstallAt: installAt, Weeks: weeks, BeforePerWeekUSD: before.AvoidableUSD / weeks, CurrentPerWeekUSD: current.AvoidableUSD / since}
}
