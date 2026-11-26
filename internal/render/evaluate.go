package render

import (
	"github.com/coreyx/claude-token-shield/internal/assess"
	"github.com/coreyx/claude-token-shield/internal/cost"
	"github.com/coreyx/claude-token-shield/internal/data"
	"github.com/coreyx/claude-token-shield/internal/levers"
	"github.com/coreyx/claude-token-shield/internal/native"
)

// Context is everything Evaluate needs besides the session and the time.
type Context struct {
	Data         *data.Shared
	Env          assess.Env
	CCVersion    string
	WarnWindows  map[string]int
	Learned      *assess.Learned
	DefaultModel string
	Mode         string
}

// Evaluation holds every intermediate result.
type Evaluation struct {
	A       assess.Assessment
	Billing string
	Model   string
	Cost    *cost.NextTurn
	Quotes  []levers.Quote
	Rec     levers.Recommendation
	View    View
}

// ExitCodes are what tshield check returns per state (REQ-19.0.3).
var ExitCodes = map[string]int{"HOT": 0, "EXPIRING": 10, "UNCERTAIN": 20, "INVALIDATED": 30, "COLD": 40, "UNKNOWN": 50}

// Evaluate assesses a session, prices the next turn, quotes and recommends,
// and builds the view, as evaluate does in plugin/core/pipeline.ts.
func Evaluate(s native.State, now float64, ctx Context) Evaluation {
	a := assess.Assess(s, now, assess.Params{
		Rules: &ctx.Data.Rules, Env: ctx.Env, CCVersion: ctx.CCVersion, WarnWindows: ctx.WarnWindows, Learned: ctx.Learned,
	})
	snap := s.LastSnapshot
	billing := cost.BillingMode(snap, ctx.Env.Provider)
	model := ctx.DefaultModel
	switch {
	case snap != nil && snap.Model.Known():
		model = snap.Model.V
	case s.LastTouch != nil:
		model = s.LastTouch.Model
	}
	ttl := "5m"
	if a.TTL.Known() {
		ttl = a.TTL.V
	}
	fast := false
	if snap != nil {
		fast = snap.FastMode.Known() && snap.FastMode.V
	} else if s.LastTouch != nil {
		fast = s.LastTouch.Speed == "fast"
	}
	var c *cost.NextTurn
	if a.State != "UNKNOWN" && model != "" && a.PrefixTokens.Known() {
		n := cost.NextTurnCost(cost.Input{PrefixTokens: a.PrefixTokens.V, Model: model, TTL: ttl, Provider: ctx.Env.Provider, Fast: fast, At: now}, &ctx.Data.Prices)
		c = &n
	}
	quotes := []levers.Quote{}
	if model != "" {
		quotes = levers.QuoteLevers(a, s, levers.Context{Prices: &ctx.Data.Prices, Model: model, Provider: ctx.Env.Provider, Fast: fast, Now: now})
	}
	rec := levers.Recommend(a, quotes)
	return Evaluation{A: a, Billing: billing, Model: model, Cost: c, Quotes: quotes, Rec: rec, View: CheckView(a, s, quotes, rec, c, billing, ctx.Mode)}
}
