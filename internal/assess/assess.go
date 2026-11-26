// Package assess classifies the main conversation's cache, mirroring
// plugin/core/assess (design.md D3). The parity fixtures hold both to the same
// states, probabilities, confidence and drivers.
package assess

import (
	"math"

	"github.com/coreyx/claude-token-shield/internal/data"
	"github.com/coreyx/claude-token-shield/internal/native"
)

// Env is the environment that decides how some events affect the cache.
type Env struct {
	Provider                  string `json:"provider"`
	ToolSearch                bool   `json:"toolSearch"`
	ExperimentalBetasDisabled bool   `json:"experimentalBetasDisabled"`
}

// Learned holds rates learned from the user's history.
type Learned struct {
	EpsWithin, EpsAfter float64
	N                   int
	Drift               bool
}

// Params is everything Assess needs besides the state and time.
type Params struct {
	Rules       *data.Rules
	Env         Env
	CCVersion   string
	WarnWindows map[string]int
	Learned     *Learned
}

// Driver is one reason behind the assessment.
type Driver struct {
	Key    string         `json:"key"`
	Params map[string]any `json:"params"`
	Tier   native.Tier    `json:"tier"`
}

// Pending is a pending event with its impact here.
type Pending struct {
	Event  native.Event
	Impact string
}

// Assessment is the assessor's answer (plugin/core/assess/types.ts).
type Assessment struct {
	State         string
	At            float64
	PHit          *float64
	Interval      *[2]float64
	LowEvidence   bool
	Confidence    string
	UnknownReason string
	Cause         *native.Event
	TTL           native.Value[string]
	ExpiresAt     native.Value[float64]
	RemainingSec  *float64
	MarginSec     float64
	WarnWindowSec float64
	PrefixTokens  native.Value[float64]
	Pending       []Pending
	Stale         bool
	DriftSec      *float64
	NativeMissing bool
	Drivers       []Driver
}

var ttlSec = map[string]float64{"5m": 300, "1h": 3600}

const (
	unmeasuredStartErrSec = 30
	logitHalfWidth        = 1.2
)

// Assess classifies the cache at now (epoch ms).
func Assess(s native.State, now float64, p Params) Assessment {
	r := p.Rules
	snap := s.LastSnapshot
	var pc *native.PromptCache
	if snap != nil {
		pc = snap.PromptCache
	}
	touch := s.LastTouch
	drivers := []Driver{}

	// A resumed or forked session before its first snapshot or request: its
	// timing follows from how long ago the last response was and the last
	// recorded TTL (REQ-11, inferred). Any snapshot or request supersedes it.
	var resume *native.Resume
	if snap == nil && touch == nil {
		resume = s.Resume
	}
	ttl := pickTTL(pc, touch)
	if resume != nil && resume.TTL != nil {
		ttl = native.Of(native.Inferred, *resume.TTL)
	}
	var resumeExpiry *float64
	if resume != nil && resume.TTL != nil && resume.SecondsSinceLastResponse != nil {
		v := resume.Ts - *resume.SecondsSinceLastResponse*1000 + ttlSec[*resume.TTL]*1000
		resumeExpiry = &v
	}
	resumeKnown := resume != nil && ((resume.LikelyExpired != nil && *resume.LikelyExpired) || resumeExpiry != nil)
	var ownExpiry *float64
	if touch != nil && ttl.Known() {
		v := touch.TsStart + ttlSec[ttl.V]*1000
		ownExpiry = &v
	}
	var nativeExpiry *float64
	if pc != nil && pc.ExpiresAt.Known() {
		v := pc.ExpiresAt.V
		nativeExpiry = &v
	}
	var expiresAt native.Value[float64]
	switch {
	case nativeExpiry != nil:
		expiresAt = pc.ExpiresAt
	case ownExpiry != nil:
		expiresAt = native.Of(native.Inferred, *ownExpiry)
	case resumeExpiry != nil:
		expiresAt = native.Of(native.Inferred, *resumeExpiry)
	default:
		expiresAt = native.None[float64]("missing")
	}

	tErr := r.Timing.NativeTimeErrSec
	if nativeExpiry == nil && (touch == nil || touch.TsStartTier != native.Measured) {
		d := float64(unmeasuredStartErrSec * 1000)
		if touch != nil && touch.DurationMs != nil {
			d = *touch.DurationMs
		}
		tErr = d / 1000
	}
	margin := r.Timing.SkewSec + tErr + r.Timing.BaseMarginSec
	var remaining *float64
	if expiresAt.Known() {
		v := (expiresAt.V - now) / 1000
		remaining = &v
	}
	var drift *float64
	if nativeExpiry != nil && ownExpiry != nil && math.Abs(*nativeExpiry-*ownExpiry)/1000 > margin {
		v := jsRound(math.Abs(*nativeExpiry-*ownExpiry) / 1000)
		drift = &v
	}

	windows := p.WarnWindows
	if windows == nil {
		windows = r.WarnWindowsSec
	}
	warn := math.Min(float64(windows["1h"]), float64(windows["5m"]))
	if ttl.Known() {
		warn = float64(windows[ttl.V])
	}
	prefix := pickPrefix(pc, touch)
	if !prefix.Known() && resume != nil && resume.ContextTokens != nil {
		prefix = native.Of(native.Inferred, *resume.ContextTokens)
	}
	stale := snap != nil && now-snap.ReceivedAt > r.Timing.StaleSnapshotSec*1000
	nativeMissing := snap == nil
	model := ""
	if snap != nil && snap.Model.Known() {
		model = snap.Model.V
	} else if touch != nil {
		model = touch.Model
	}
	pending := make([]Pending, 0, len(s.Pending))
	for _, e := range s.Pending {
		pending = append(pending, Pending{Event: e, Impact: EventImpact(e, r, p.Env, model)})
	}

	epsWithin, epsAfter := r.Priors.EpsWithin, r.Priors.EpsAfter
	if p.Learned != nil {
		epsWithin, epsAfter = p.Learned.EpsWithin, p.Learned.EpsAfter
	}
	lowEvidence := p.Learned == nil || p.Learned.N < r.Priors.MinCalibrationN

	a := Assessment{
		At: now, TTL: ttl, ExpiresAt: expiresAt, RemainingSec: remaining, MarginSec: margin, WarnWindowSec: warn,
		PrefixTokens: prefix, Pending: pending, Stale: stale, DriftSec: drift, NativeMissing: nativeMissing,
	}
	unknown := func(reason string, d Driver) Assessment {
		a.Drivers = append(drivers, d)
		a.State, a.LowEvidence, a.Confidence, a.UnknownReason = "UNKNOWN", true, "LOW", reason
		return a
	}

	// 1. UNKNOWN.
	ver := p.CCVersion
	if ver == "" && snap != nil && snap.CCVersion.Known() {
		ver = snap.CCVersion.V
	}
	if ver != "" {
		if c, ok := native.CompareVersions(ver, r.MinClaudeCodeVersion); ok && c < 0 {
			return unknown("version", Driver{"driver.version", map[string]any{"version": ver, "min": r.MinClaudeCodeVersion}, native.Measured})
		}
	}
	if (snap != nil && pc == nil) || (snap == nil && touch == nil && !resumeKnown) {
		return unknown("no_response", Driver{"driver.no_response", map[string]any{}, native.Measured})
	}
	if pc != nil && pc.CachingObserved.Known() && !pc.CachingObserved.V {
		return unknown("caching_off", Driver{"driver.caching_off", map[string]any{}, native.Measured})
	}

	if ttl.Known() {
		src := "request"
		if pc != nil && pc.TTL.Known() {
			src = "prompt_cache.ttl"
		}
		drivers = append(drivers, Driver{"driver.ttl", map[string]any{"ttl": ttl.V, "source": src}, native.Measured})
	}
	if expiresAt.Known() {
		src := "shield"
		if nativeExpiry != nil {
			src = "claude-code"
		}
		drivers = append(drivers, Driver{"driver.expiry", map[string]any{"source": src}, native.Inferred})
		drivers = append(drivers, Driver{"driver.remaining", map[string]any{"seconds": jsRound(*remaining), "margin": jsRound(margin)}, native.Inferred})
	} else {
		drivers = append(drivers, Driver{"driver.expiry_unknown", map[string]any{}, native.Inferred})
	}
	if len(pending) == 0 {
		drivers = append(drivers, Driver{"driver.pending_none", map[string]any{}, native.Measured})
	}
	for _, pe := range pending {
		drivers = append(drivers, Driver{"driver.event", map[string]any{"kind": pe.Event.Kind, "impact": pe.Impact}, native.Inferred})
	}
	if stale {
		drivers = append(drivers, Driver{"driver.stale", map[string]any{"seconds": jsRound((now - snap.ReceivedAt) / 1000)}, native.Measured})
	}
	if drift != nil {
		drivers = append(drivers, Driver{"driver.drift", map[string]any{"seconds": *drift}, native.Inferred})
	}
	if nativeMissing {
		drivers = append(drivers, Driver{"driver.native_unavailable", map[string]any{}, native.Measured})
	}
	if resume != nil {
		drivers = append(drivers, Driver{"driver.resume", map[string]any{}, native.Inferred})
	}
	if p.Learned != nil && p.Learned.Drift {
		drivers = append(drivers, Driver{"driver.calibration_drift", map[string]any{}, native.Estimated})
	}

	timingCaps := func(c string) string {
		out := c
		if nativeMissing || (nativeExpiry == nil && (touch == nil || touch.TsStartTier != native.Measured)) {
			out = capAt(out, "MEDIUM")
		}
		if drift != nil || (p.Learned != nil && p.Learned.Drift) {
			out = capAt(out, "MEDIUM")
		}
		if stale {
			out = "LOW"
		}
		return out
	}
	known := func(state string, pHit float64, interval [2]float64, confidence string) Assessment {
		eps := epsWithin
		if state == "COLD" || state == "INVALIDATED" {
			eps = epsAfter
		}
		n := 0
		if p.Learned != nil {
			n = p.Learned.N
		}
		evidence := "calibrated"
		if lowEvidence {
			evidence = "low"
		}
		a.Drivers = append(drivers, Driver{"driver.eps", map[string]any{"eps": eps, "n": n, "evidence": evidence}, native.Estimated})
		a.State, a.PHit, a.Interval, a.LowEvidence, a.Confidence = state, &pHit, &interval, lowEvidence, confidence
		return a
	}

	// 2. INVALIDATED.
	for _, pe := range pending {
		if pe.Impact == "WILL" {
			ev := pe.Event
			out := known("INVALIDATED", epsAfter, nearZero(epsAfter), "HIGH")
			out.Cause = &ev
			return out
		}
	}
	// 3. COLD.
	warmFalse := pc != nil && pc.Warm.Known() && !pc.Warm.V
	if warmFalse {
		drivers = append(drivers, Driver{"driver.warm_false", map[string]any{}, native.Inferred})
	}
	// Claude Code judged a resumed session's cache likely expired.
	resumeCold := resume != nil && resume.LikelyExpired != nil && *resume.LikelyExpired
	if warmFalse || resumeCold || (remaining != nil && *remaining < -margin) {
		conf := timingCaps("HIGH")
		if warmFalse {
			conf = "HIGH"
		}
		return known("COLD", epsAfter, nearZero(epsAfter), conf)
	}
	// 4. UNCERTAIN.
	mayCount := 0
	for _, pe := range pending {
		if pe.Impact == "MAY" {
			mayCount++
		}
	}
	boundary := remaining != nil && math.Abs(*remaining) <= margin
	if boundary || mayCount > 0 || stale {
		pTime := 1 - epsWithin
		if boundary {
			pTime = boundaryProbability(*remaining, margin, epsWithin, epsAfter)
		}
		mean := r.Priors.MayEvent.Alpha / (r.Priors.MayEvent.Alpha + r.Priors.MayEvent.Beta)
		pHit := pTime
		for i := 0; i < mayCount; i++ {
			pHit *= 1 - mean
		}
		conf := "MEDIUM"
		if mayCount > 0 && lowEvidence {
			conf = "LOW"
		}
		return known("UNCERTAIN", pHit, logitBand(pHit), timingCaps(conf))
	}
	// 5–6. EXPIRING or HOT.
	state := "HOT"
	if remaining != nil && *remaining <= warn {
		state = "EXPIRING"
	}
	conf := timingCaps("HIGH")
	if !expiresAt.Known() {
		conf = "MEDIUM"
	}
	return known(state, 1-epsWithin, nearOne(epsWithin), conf)
}

var rank = map[string]int{"LOW": 0, "MEDIUM": 1, "HIGH": 2}

// capAt lowers c to at most limit.
func capAt(c, limit string) string {
	if rank[c] < rank[limit] {
		return c
	}
	return limit
}

// pickTTL takes the snapshot's TTL, else the last request's.
func pickTTL(pc *native.PromptCache, touch *native.Request) native.Value[string] {
	if pc != nil && pc.TTL.Known() {
		return pc.TTL
	}
	if touch != nil && touch.TTL != "" {
		return native.Of(native.Measured, touch.TTL)
	}
	if pc != nil {
		return pc.TTL
	}
	return native.None[string]("missing")
}

// pickPrefix takes Claude Code's recache_tokens_if_cold, else the last request's full window.
func pickPrefix(pc *native.PromptCache, touch *native.Request) native.Value[float64] {
	if pc != nil && pc.RecacheTokensIfCold.Known() {
		return pc.RecacheTokensIfCold
	}
	if touch != nil {
		u := touch.Usage
		return native.Of(native.Inferred, u.Input+u.Read+u.Write5m+u.Write1h+u.Output)
	}
	if pc != nil {
		return pc.RecacheTokensIfCold
	}
	return native.None[float64]("missing")
}

func boundaryProbability(remaining, margin, epsWithin, epsAfter float64) float64 {
	s := 1 / (1 + math.Exp(-(3*remaining)/margin))
	return epsAfter + (1-epsWithin-epsAfter)*s
}

func nearOne(eps float64) [2]float64 { return [2]float64{math.Max(0, 1-3*eps), 1 - eps/2} }

func nearZero(eps float64) [2]float64 { return [2]float64{eps / 2, math.Min(1, 3*eps)} }

func logitBand(p float64) [2]float64 {
	c := math.Min(math.Max(p, 1e-6), 1-1e-6)
	l := math.Log(c / (1 - c))
	sig := func(x float64) float64 { return 1 / (1 + math.Exp(-x)) }
	return [2]float64{sig(l - logitHalfWidth), sig(l + logitHalfWidth)}
}

// jsRound rounds like JavaScript's Math.round: halves go toward +Infinity.
func jsRound(x float64) float64 { return math.Floor(x + 0.5) }

// EventImpact looks an event up in the invalidation table; an unknown kind is MAY.
func EventImpact(e native.Event, r *data.Rules, env Env, model string) string {
	var rule *data.EventRule
	for i := range r.Events {
		if r.Events[i].Kind == e.Kind {
			rule = &r.Events[i]
			break
		}
	}
	if rule == nil {
		return "MAY"
	}
	perMessage := false
	if model != "" {
		base := native.BaseModelID(model)
		for _, m := range r.PerMessageEffortModels {
			if m == base {
				perMessage = true
			}
		}
	}
	for _, c := range rule.Cases {
		w := c.When
		if w.PerMessageEffort != nil && *w.PerMessageEffort != perMessage {
			continue
		}
		if w.ToolSearch != nil && *w.ToolSearch != env.ToolSearch {
			continue
		}
		if w.ExperimentalBetasDisabled != nil && *w.ExperimentalBetasDisabled != env.ExperimentalBetasDisabled {
			continue
		}
		if w.Provider != nil && !contains(w.Provider, env.Provider) {
			continue
		}
		return c.Impact
	}
	return rule.Impact
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
