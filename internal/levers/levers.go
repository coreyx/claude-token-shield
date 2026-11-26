// Package levers quotes every lever for the current state and recommends one,
// mirroring plugin/core/recommend (design.md D6).
package levers

import (
	"math"

	"github.com/coreyx/claude-token-shield/internal/assess"
	"github.com/coreyx/claude-token-shield/internal/cost"
	"github.com/coreyx/claude-token-shield/internal/data"
	"github.com/coreyx/claude-token-shield/internal/native"
)

// Cost is a cost in dollars and tokens; nil means unknown.
type Cost struct {
	USD    *float64
	Tokens *float64
}

// Quote is one lever priced for the current state.
type Quote struct {
	Lever        string
	Kind         string
	Now          Cost
	PerTurnAfter *Cost
	HorizonUSD   *float64
	EffectKey    string
	WhenKey      string
	Tier         native.Tier
}

// Context is what quoting needs besides the assessment and the session.
type Context struct {
	Prices          *data.Prices
	Model           string
	Provider        string
	Fast            bool
	Now             float64
	SummaryFraction *float64
	SystemTokens    *float64
}

// Constants shared with the TypeScript core.
const (
	HorizonTurns           = 5
	DefaultSummaryFraction = 0.08
	helperTTL              = "5m"
)

func f(v float64) *float64 { return &v }

// QuoteLevers quotes every lever applicable to the assessment; UNKNOWN has none.
func QuoteLevers(a assess.Assessment, s native.State, ctx Context) []Quote {
	if a.State == "UNKNOWN" {
		return []Quote{}
	}
	var prefix *float64
	if a.PrefixTokens.Known() {
		prefix = f(a.PrefixTokens.V)
	}
	ttl := "5m"
	if a.TTL.Known() {
		ttl = a.TTL.V
	}
	p := *a.PHit

	type rw struct{ read, write float64 }
	price := func(tokens float64, t string) *rw {
		c := cost.NextTurnCost(cost.Input{PrefixTokens: tokens, Model: ctx.Model, TTL: t, Provider: ctx.Provider, Fast: ctx.Fast, At: ctx.Now}, ctx.Prices)
		if c.USD == nil {
			return nil
		}
		return &rw{c.USD.Warm, c.USD.Cold}
	}
	after := func(tokens *float64) *Cost {
		if tokens == nil {
			return &Cost{}
		}
		pr := price(*tokens, ttl)
		if pr == nil {
			return &Cost{Tokens: tokens}
		}
		return &Cost{USD: f(pr.read), Tokens: tokens}
	}
	horizon := func(now Cost, later *Cost) *float64 {
		if now.USD == nil || (later != nil && later.USD == nil) {
			return nil
		}
		extra := 0.0
		if later != nil {
			extra = *later.USD
		}
		return f(*now.USD + HorizonTurns*extra)
	}
	quote := func(lever, kind string, now Cost, later *Cost, tier native.Tier, effect string) Quote {
		return Quote{Lever: lever, Kind: kind, Now: now, PerTurnAfter: later, HorizonUSD: horizon(now, later), EffectKey: "effect." + effect, WhenKey: "lever." + lever + ".when", Tier: tier}
	}

	quotes := []Quote{}
	var full *rw
	if prefix != nil {
		full = price(*prefix, ttl)
	}
	var expected *float64
	if full != nil {
		expected = f(p*full.read + (1-p)*full.write)
	}
	quotes = append(quotes, quote("continue", "choice", Cost{USD: expected, Tokens: prefix}, after(prefix), native.Estimated, "unchanged"))

	system := ctx.SystemTokens
	if system == nil {
		system = systemLayer(s)
	}
	var summary, compactPrefix, compactNow *float64
	if prefix != nil {
		frac := DefaultSummaryFraction
		if ctx.SummaryFraction != nil {
			frac = *ctx.SummaryFraction
		}
		summary = f(jsRound(*prefix * frac))
	}
	if summary != nil && system != nil {
		compactPrefix = f(*system + *summary)
	}
	if prefix != nil && summary != nil && compactPrefix != nil {
		helper := price(*prefix, helperTTL)
		rebuilt := price(*compactPrefix, ttl)
		out, ok := cost.OutputUSD(*summary, ctx.Model, ctx.Provider, ctx.Now, ctx.Prices)
		if helper != nil && rebuilt != nil && ok {
			compactNow = f(p*helper.read + (1-p)*helper.write + out + rebuilt.write)
		}
	}
	quotes = append(quotes, quote("compact", "command", Cost{USD: compactNow, Tokens: compactPrefix}, after(compactPrefix), native.Estimated, "compact"))

	var clearUSD *float64
	if system != nil {
		if pr := price(*system, ttl); pr != nil {
			clearUSD = f(pr.write)
		}
	}
	quotes = append(quotes, quote("clear", "command", Cost{USD: clearUSD, Tokens: system}, after(system), native.Estimated, "clear"))

	if tokens, warm, ok := rewindTarget(s, ctx.Now); ok {
		var usd *float64
		if warm {
			if pr := price(tokens, ttl); pr != nil {
				usd = f(pr.read)
			}
		}
		quotes = append(quotes, quote("rewind", "command", Cost{USD: usd, Tokens: f(tokens)}, after(f(tokens)), native.Inferred, "rewind"))
	}

	quotes = append(quotes, quote("recap", "command", Cost{USD: f(0), Tokens: f(0)}, nil, native.Inferred, "none"))

	var btw *float64
	if (a.State == "HOT" || a.State == "EXPIRING") && full != nil {
		btw = f(full.read)
	}
	quotes = append(quotes, quote("btw", "command", Cost{USD: btw, Tokens: prefix}, nil, native.Estimated, "none"))

	if a.State == "HOT" || a.State == "EXPIRING" || a.State == "UNCERTAIN" {
		var read *float64
		if full != nil {
			read = f(full.read)
		}
		quotes = append(quotes, quote("keepalive", "spend", Cost{USD: read, Tokens: prefix}, nil, native.Estimated, "keepalive"))
		quotes = append(quotes, quote("probe", "spend", Cost{USD: expected, Tokens: prefix}, nil, native.Estimated, "probe"))
	}

	quotes = append(quotes, quote("ttl", "setting", Cost{USD: f(0), Tokens: f(0)}, nil, native.Estimated, "ttl"))

	var rebuild *float64
	if full != nil {
		rebuild = f(full.write)
	}
	quotes = append(quotes, quote("model", "choice", Cost{USD: rebuild, Tokens: prefix}, nil, native.Estimated, "rebuild"))
	return quotes
}

// systemLayer is what the first main request wrote.
func systemLayer(s native.State) *float64 {
	if len(s.Requests) == 0 {
		return nil
	}
	u := s.Requests[0].Usage
	if w := u.Write5m + u.Write1h; w > 0 {
		return f(w)
	}
	return nil
}

// rewindTarget is the newest earlier main request: its prefix and whether it is still warm.
func rewindTarget(s native.State, now float64) (tokens float64, warm, ok bool) {
	if len(s.Requests) < 2 {
		return 0, false, false
	}
	e := s.Requests[len(s.Requests)-2]
	ttl := 300.0
	if e.TTL == "1h" {
		ttl = 3600
	}
	u := e.Usage
	return u.Input + u.Read + u.Write5m + u.Write1h, e.TsStart+ttl*1000 > now, true
}

// jsRound rounds like JavaScript's Math.round.
func jsRound(x float64) float64 { return math.Floor(x + 0.5) }

// Recommendation is the policy's answer.
type Recommendation struct {
	Lever     string         `json:"lever"`
	ReasonKey string         `json:"reasonKey"`
	Params    map[string]any `json:"params"`
	ProbeHint bool           `json:"probeHint"`
}

// Recommend picks one lever, or none, per design D6's ordered policy.
func Recommend(a assess.Assessment, quotes []Quote) Recommendation {
	none := func(key string, params map[string]any) Recommendation {
		if params == nil {
			params = map[string]any{}
		}
		return Recommendation{Lever: "none", ReasonKey: key, Params: params}
	}
	expiry := func() map[string]any {
		if !a.ExpiresAt.Known() {
			return map[string]any{}
		}
		return map[string]any{"expiresAt": a.ExpiresAt.V}
	}
	switch a.State {
	case "HOT":
		return none("recommend.none.hot", expiry())
	case "EXPIRING":
		return Recommendation{Lever: "continue", ReasonKey: "recommend.continue.expiring", Params: expiry()}
	case "UNCERTAIN":
		p := *a.PHit
		return Recommendation{Lever: "continue", ReasonKey: "recommend.continue.uncertain", Params: map[string]any{}, ProbeHint: p >= 0.2 && p <= 0.8}
	case "COLD", "INVALIDATED":
		var best *Quote
		for i := range quotes {
			q := &quotes[i]
			if (q.Lever == "continue" || q.Lever == "compact" || q.Lever == "rewind") && q.HorizonUSD != nil {
				if best == nil || *q.HorizonUSD < *best.HorizonUSD {
					best = q
				}
			}
		}
		if best == nil {
			return none("recommend.none.unknown_costs", nil)
		}
		return Recommendation{Lever: best.Lever, ReasonKey: "recommend.cheapest", Params: map[string]any{"lever": best.Lever, "usd": *best.HorizonUSD}}
	default:
		return none("recommend.none.unknown", map[string]any{"reason": a.UnknownReason})
	}
}
