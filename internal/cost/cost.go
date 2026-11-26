// Package cost prices the next turn and past requests, mirroring
// plugin/core/cost (design.md D4 and D5).
package cost

import (
	"encoding/json"
	"sort"
	"time"

	"github.com/coreyx/claude-token-shield/internal/data"
	"github.com/coreyx/claude-token-shield/internal/native"
)

const perMTok = 1e-6

// TableAt returns the price table in effect on a date (the newest whose
// effective day is on or before it), else the oldest.
func TableAt(p *data.Prices, at float64) *data.PriceTable {
	day := time.UnixMilli(int64(at)).UTC().Format("2006-01-02")
	idx := make([]int, len(p.Tables))
	for i := range idx {
		idx[i] = i
	}
	sort.SliceStable(idx, func(a, b int) bool { return p.Tables[idx[a]].Effective < p.Tables[idx[b]].Effective })
	chosen := &p.Tables[idx[0]]
	for _, i := range idx {
		if p.Tables[i].Effective <= day {
			chosen = &p.Tables[i]
		}
	}
	return chosen
}

// ModelPrice returns a model's prices by base id.
func ModelPrice(t *data.PriceTable, model string) (data.ModelPrice, bool) {
	m, ok := t.Models[native.BaseModelID(model)]
	return m, ok
}

// Input is what NextTurnCost prices.
type Input struct {
	PrefixTokens float64
	TailTokens   *float64
	Model        string
	TTL          string
	Provider     string
	Regional     bool
	Fast         bool
	At           float64
}

// Dollars are a warm/cold pair.
type Dollars struct{ Warm, Cold, Penalty float64 }

// NextTurn is the next turn's first request, priced.
type NextTurn struct {
	PrefixTokens  float64
	TailTokens    float64
	TailTier      native.Tier
	USD           *Dollars
	PriceDate     string
	ProviderBasis string
	PlanShare     *Shares
}

// NextTurnCost prices the first request of the next turn warm and cold.
func NextTurnCost(in Input, p *data.Prices) NextTurn {
	t := TableAt(p, in.At)
	tail := 0.0
	tier := native.Estimated
	if in.TailTokens != nil {
		tail, tier = *in.TailTokens, native.Measured
	}
	prov, hasProv := t.Providers[in.Provider]
	basis := "estimated"
	if hasProv {
		basis = prov.Basis
	}
	out := NextTurn{PrefixTokens: in.PrefixTokens, TailTokens: tail, TailTier: tier, PriceDate: t.Effective, ProviderBasis: basis}
	price, ok := ModelPrice(t, in.Model)
	if !ok {
		return out
	}
	mult := 1.0
	if hasProv {
		mult = prov.Multiplier
		if in.Regional && prov.RegionalMultiplier != nil {
			mult *= *prov.RegionalMultiplier
		}
	}
	perToken := inputRate(price, in.PrefixTokens+tail, in.Fast) * perMTok * mult
	write := price.Write5mMult
	if in.TTL == "1h" {
		write = price.Write1hMult
	}
	warm := in.PrefixTokens*perToken*price.ReadMult + tail*perToken*write
	cold := in.PrefixTokens * perToken * write
	out.USD = &Dollars{Warm: warm, Cold: cold, Penalty: cold - warm}
	return out
}

// inputRate is the base rate for a prompt: the highest tier exceeded, or the fast rate.
func inputRate(p data.ModelPrice, promptTokens float64, fast bool) float64 {
	if fast && p.FastInput != nil {
		return *p.FastInput
	}
	tiers := append([]data.PriceTier{}, p.Tiers...)
	sort.SliceStable(tiers, func(a, b int) bool { return tiers[a].Above < tiers[b].Above })
	rate := p.Input
	for _, t := range tiers {
		if promptTokens > float64(t.Above) {
			rate = t.Input
		}
	}
	return rate
}

// RequestUSD is a past request's API-equivalent dollars, output included.
func RequestUSD(r native.Request, p *data.Prices) (float64, bool) {
	price, ok := ModelPrice(TableAt(p, r.TsStart), r.Model)
	if !ok {
		return 0, false
	}
	u := r.Usage
	per := inputRate(price, u.Input+u.Read+u.Write5m+u.Write1h, r.Speed == "fast") * perMTok
	return per * (u.Input + u.Read*price.ReadMult + u.Write5m*price.Write5mMult + u.Write1h*price.Write1hMult + u.Output*price.OutputMult), true
}

// OutputUSD prices tokens of model output.
func OutputUSD(tokens float64, model, provider string, at float64, p *data.Prices) (float64, bool) {
	t := TableAt(p, at)
	price, ok := ModelPrice(t, model)
	if !ok {
		return 0, false
	}
	mult := 1.0
	if prov, ok := t.Providers[provider]; ok {
		mult = prov.Multiplier
	}
	return tokens * price.Input * price.OutputMult * perMTok * mult, true
}

// BillingMode infers how the session is billed.
func BillingMode(s *native.Snapshot, provider string) string {
	if provider == "bedrock" || provider == "vertex" || provider == "foundry" {
		return "provider"
	}
	if s == nil || (!s.FiveHour.Known() && !s.SevenDay.Known()) {
		return "api"
	}
	if s.PromptCache != nil && s.PromptCache.TTL.Known() && s.PromptCache.TTL.V == "5m" {
		return "subscription-credits"
	}
	return "subscription"
}

// Presentation says which units a billing mode shows.
type Presentation struct {
	Dollars     bool
	DollarLabel string
	PlanShare   bool
}

// Present decides the units for a billing mode (REQ-3.0.2, 3.0.3).
func Present(mode string, verbose bool) Presentation {
	switch mode {
	case "subscription":
		return Presentation{Dollars: verbose, DollarLabel: "cost.api_equivalent", PlanShare: true}
	case "subscription-credits":
		return Presentation{Dollars: true, DollarLabel: "cost.api_equivalent", PlanShare: true}
	case "provider":
		return Presentation{Dollars: true, DollarLabel: "cost.provider_priced"}
	default:
		return Presentation{Dollars: true, DollarLabel: "cost.api_equivalent"}
	}
}

// Share is a cost as a share of the 5-hour window ("estimated"), or
// "learning" with the windows seen so far.
type Share struct {
	Status         string
	Windows        int
	Pct, Low, High float64
}

// MarshalJSON writes the same shape as the TypeScript PlanShare union.
func (s Share) MarshalJSON() ([]byte, error) {
	if s.Status == "learning" {
		return json.Marshal(map[string]any{"status": s.Status, "windows": s.Windows})
	}
	return json.Marshal(map[string]any{"status": s.Status, "pct": s.Pct, "low": s.Low, "high": s.High})
}

// Shares is the warm and cold plan share.
type Shares struct {
	Warm Share `json:"warm"`
	Cold Share `json:"cold"`
}
