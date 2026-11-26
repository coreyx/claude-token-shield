package render

import (
	"github.com/coreyx/claude-token-shield/internal/assess"
	"github.com/coreyx/claude-token-shield/internal/cost"
	"github.com/coreyx/claude-token-shield/internal/levers"
	"github.com/coreyx/claude-token-shield/internal/native"
)

// ViewValue is a value with its tier; Value is nil when absent.
type ViewValue[T any] struct {
	Value *T          `json:"value"`
	Tier  native.Tier `json:"tier"`
}

// LastRequest is when the last request touching the prefix started.
type LastRequest struct {
	TsStart float64     `json:"tsStart"`
	Tier    native.Tier `json:"tier"`
}

// LastMiss is Claude Code's last diagnosed miss.
type LastMiss struct {
	At     *float64 `json:"at"`
	Causes []string `json:"causes"`
}

// Session holds Claude Code's session counters.
type Session struct {
	Requests *float64  `json:"requests"`
	HitRatio *float64  `json:"hitRatio"`
	Misses   *float64  `json:"misses"`
	LastMiss *LastMiss `json:"lastMiss"`
}

// PendingView is a pending event and its impact.
type PendingView struct {
	Kind   string `json:"kind"`
	Impact string `json:"impact"`
}

// CostView is the next turn's cost as the view carries it.
type CostView struct {
	Tokens      float64      `json:"tokens"`
	WarmUSD     *float64     `json:"warmUsd"`
	ColdUSD     *float64     `json:"coldUsd"`
	ShowDollars bool         `json:"showDollars"`
	DollarLabel string       `json:"dollarLabel"`
	PriceDate   string       `json:"priceDate"`
	TailTier    native.Tier  `json:"tailTier"`
	PlanShare   *cost.Shares `json:"planShare"`
}

// LeverView is one quoted lever.
type LeverView struct {
	Lever       string      `json:"lever"`
	NowUSD      *float64    `json:"nowUsd"`
	NowTokens   *float64    `json:"nowTokens"`
	HorizonUSD  *float64    `json:"horizonUsd"`
	EffectKey   string      `json:"effectKey"`
	WhenKey     string      `json:"whenKey"`
	Tier        native.Tier `json:"tier"`
	Recommended bool        `json:"recommended"`
}

// TimelineRow is one request in the verbose timeline.
type TimelineRow struct {
	TsStart float64  `json:"tsStart"`
	GapSec  *float64 `json:"gapSec"`
	Read    float64  `json:"read"`
	Write   float64  `json:"write"`
	Input   float64  `json:"input"`
	Outcome string   `json:"outcome"`
}

// Change is one difference between the last two requests, or a pending change.
type Change struct {
	Field string  `json:"field"`
	From  *string `json:"from"`
	To    *string `json:"to"`
}

// Diff is the diff view's content.
type Diff struct {
	Changes    []Change `json:"changes"`
	MissCauses []string `json:"missCauses"`
}

// Expiry holds the native and own expiry and their drift.
type Expiry struct {
	Native   *float64 `json:"native"`
	Shield   *float64 `json:"shield"`
	DriftSec *float64 `json:"driftSec"`
}

// View is the check view model (schemas/check.schema.json).
type View struct {
	V              int                   `json:"v"`
	Mode           string                `json:"mode"`
	At             float64               `json:"at"`
	State          string                `json:"state"`
	PHit           *float64              `json:"pHit"`
	Interval       *[2]float64           `json:"interval"`
	Confidence     string                `json:"confidence"`
	LowEvidence    bool                  `json:"lowEvidence"`
	Stale          bool                  `json:"stale"`
	UnknownReason  *string               `json:"unknownReason"`
	TTL            ViewValue[string]     `json:"ttl"`
	ExpiresAt      ViewValue[float64]    `json:"expiresAt"`
	RemainingSec   *float64              `json:"remainingSec"`
	Expiry         Expiry                `json:"expiry"`
	PrefixTokens   ViewValue[float64]    `json:"prefixTokens"`
	LastRequest    *LastRequest          `json:"lastRequest"`
	Session        Session               `json:"session"`
	Pending        []PendingView         `json:"pending"`
	Cost           *CostView             `json:"cost"`
	Billing        string                `json:"billing"`
	Levers         []LeverView           `json:"levers"`
	Recommendation levers.Recommendation `json:"recommendation"`
	Drivers        []assess.Driver       `json:"drivers"`
	Timeline       []TimelineRow         `json:"timeline"`
	Diff           *Diff                 `json:"diff"`
}

// TimelineRows is how many requests the verbose timeline shows.
const TimelineRows = 8

// viewOf turns a tiered value into view data.
func viewOf[T any](v native.Value[T]) ViewValue[T] {
	if !v.Known() {
		return ViewValue[T]{Tier: native.Absent}
	}
	x := v.V
	return ViewValue[T]{Value: &x, Tier: v.Tier}
}

// known returns a pointer to a known value, else nil.
func known(v native.Value[float64]) *float64 {
	if !v.Known() {
		return nil
	}
	x := v.V
	return &x
}

// CheckView builds the view model, as checkView does in plugin/core/view.
func CheckView(a assess.Assessment, s native.State, quotes []levers.Quote, rec levers.Recommendation, c *cost.NextTurn, billing, mode string) View {
	var pc *native.PromptCache
	if s.LastSnapshot != nil {
		pc = s.LastSnapshot.PromptCache
	}
	v := View{
		V: 1, Mode: mode, At: a.At, State: a.State, PHit: a.PHit, Interval: a.Interval, Confidence: a.Confidence,
		LowEvidence: a.LowEvidence, Stale: a.Stale, TTL: viewOf(a.TTL), ExpiresAt: viewOf(a.ExpiresAt),
		RemainingSec: a.RemainingSec, PrefixTokens: viewOf(a.PrefixTokens), Billing: billing, Recommendation: rec,
		Drivers: a.Drivers, Pending: []PendingView{}, Levers: []LeverView{},
	}
	if a.UnknownReason != "" {
		r := a.UnknownReason
		v.UnknownReason = &r
	}
	if pc != nil {
		v.Expiry.Native = known(pc.ExpiresAt)
	}
	if t := s.LastTouch; t != nil && t.TTL != "" {
		ttl := 300.0
		if t.TTL == "1h" {
			ttl = 3600
		}
		x := t.TsStart + ttl*1000
		v.Expiry.Shield = &x
	}
	v.Expiry.DriftSec = a.DriftSec
	if t := s.LastTouch; t != nil {
		v.LastRequest = &LastRequest{TsStart: t.TsStart, Tier: t.TsStartTier}
	}
	if pc != nil {
		v.Session = Session{Requests: known(pc.Requests), HitRatio: known(pc.HitRatio), Misses: known(pc.Misses)}
		if pc.LastMissCause.Known() {
			v.Session.LastMiss = &LastMiss{At: known(pc.LastMissAt), Causes: append([]string{}, pc.LastMissCause.V.Causes...)}
		}
	}
	for _, p := range a.Pending {
		v.Pending = append(v.Pending, PendingView{Kind: p.Event.Kind, Impact: p.Impact})
	}
	if c != nil {
		pr := cost.Present(billing, mode == "verbose")
		cv := &CostView{Tokens: c.PrefixTokens, ShowDollars: pr.Dollars, DollarLabel: pr.DollarLabel, PriceDate: c.PriceDate, TailTier: c.TailTier, PlanShare: c.PlanShare}
		if c.USD != nil {
			w, cold := c.USD.Warm, c.USD.Cold
			cv.WarmUSD, cv.ColdUSD = &w, &cold
		}
		v.Cost = cv
	}
	for _, q := range quotes {
		v.Levers = append(v.Levers, LeverView{
			Lever: q.Lever, NowUSD: q.Now.USD, NowTokens: q.Now.Tokens, HorizonUSD: q.HorizonUSD,
			EffectKey: q.EffectKey, WhenKey: q.WhenKey, Tier: q.Tier, Recommended: q.Lever == rec.Lever,
		})
	}
	if mode == "verbose" {
		v.Timeline = timeline(s.Requests)
	}
	if mode == "diff" {
		v.Diff = diff(s, a, pc)
	}
	return v
}

// Outcome classifies how a later request used the cache.
func Outcome(read, write float64) string {
	if read == 0 {
		return "MISS"
	}
	if write <= 0.05*(read+write) {
		return "HIT"
	}
	return "PARTIAL"
}

func timeline(rs []native.Request) []TimelineRow {
	start := len(rs) - TimelineRows
	if start < 0 {
		start = 0
	}
	rows := []TimelineRow{}
	for i := start; i < len(rs); i++ {
		r := rs[i]
		write := r.Usage.Write5m + r.Usage.Write1h
		row := TimelineRow{TsStart: r.TsStart, Read: r.Usage.Read, Write: write, Input: r.Usage.Input, Outcome: Outcome(r.Usage.Read, write)}
		if i > 0 {
			g := jsRound((r.TsStart - rs[i-1].TsStart) / 1000)
			row.GapSec = &g
		}
		if i == 0 {
			row.Outcome = "COLD_START"
		}
		rows = append(rows, row)
	}
	return rows
}

func strp(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func diff(s native.State, a assess.Assessment, pc *native.PromptCache) *Diff {
	d := &Diff{Changes: []Change{}, MissCauses: []string{}}
	if n := len(s.Requests); n >= 2 {
		prev, last := s.Requests[n-2], s.Requests[n-1]
		fields := [][3]string{{"model", prev.Model, last.Model}, {"effort", prev.Effort, last.Effort}, {"speed", prev.Speed, last.Speed}, {"ttl", prev.TTL, last.TTL}}
		for _, fl := range fields {
			if fl[1] != fl[2] {
				d.Changes = append(d.Changes, Change{Field: fl[0], From: strp(fl[1]), To: strp(fl[2])})
			}
		}
	}
	for _, p := range a.Pending {
		if p.Event.Kind == "model_switch" && p.Event.Detail != nil {
			d.Changes = append(d.Changes, Change{Field: "model", From: strp(p.Event.Detail.From), To: strp(p.Event.Detail.To)})
		} else {
			kind := p.Event.Kind
			d.Changes = append(d.Changes, Change{Field: "event", To: &kind})
		}
	}
	if pc != nil && pc.LastMissCause.Known() {
		d.MissCauses = append(d.MissCauses, pc.LastMissCause.V.Causes...)
	}
	return d
}
