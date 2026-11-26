package render

import (
	"strconv"
	"strings"

	"github.com/coreyx/claude-token-shield/internal/levers"
	"github.com/coreyx/claude-token-shield/internal/native"
)

const labelWidth = 15

// Check renders a check view at a width, as renderCheck does in plugin/core/render.
func Check(v View, w int, o Options) string {
	g := o.Glyphs
	t := o.t()
	verbose := v.Mode == "verbose"
	clock := func(ms float64, seconds bool) string { return FormatClock(ms, o.TzOffsetMin, seconds) }
	tag := func(tier native.Tier) string {
		if !verbose {
			return ""
		}
		if tier == native.Absent {
			return t("tier.inferred", nil)
		}
		return t("tier."+string(tier), nil)
	}
	usd := func(x *float64) string {
		if x == nil {
			return t("cost.unknown", nil)
		}
		return FormatUSD(*x)
	}
	lines := []string{}
	// row writes a labelled row ("" indents under the label column, nil starts at the margin),
	// with the tier tag right-aligned in verbose output.
	row := func(label *string, value string, tier *native.Tier) {
		var left string
		switch {
		case label == nil:
			left = value
		case *label == "":
			left = strings.Repeat(" ", labelWidth) + value
		case width(*label) >= labelWidth:
			left = *label + " " + value
		default:
			left = padEnd(*label, labelWidth) + value
		}
		tg := ""
		if tier != nil {
			tg = tag(*tier)
		}
		if tg == "" {
			lines = append(lines, Fit(left, w, g.Ellipsis))
			return
		}
		room := w - width(tg) - 1
		if width(left) <= room {
			lines = append(lines, padEnd(left, w-width(tg))+tg)
		} else {
			lines = append(lines, Fit(left, room, g.Ellipsis)+" "+tg)
		}
	}
	lbl := func(key string) *string { s := t(key, nil); return &s }
	indent := func() *string { s := ""; return &s }
	tier := func(x native.Tier) *native.Tier { return &x }
	finish := func() string {
		for i, l := range lines {
			lines[i] = strings.TrimRight(l, " \t")
		}
		return strings.Join(lines, "\n")
	}

	if v.State == "UNKNOWN" {
		lines = append(lines, Fit(t("check.header_unknown", map[string]string{"reason": viewUnknownReason(v, t)}), w, g.Ellipsis))
		lines = append(lines, strings.Repeat(g.Rule, w))
		if v.LastRequest != nil {
			row(lbl("check.label.last_request"), t("check.last_request", lastRequestParams(v, clock)), tier(v.LastRequest.Tier))
		}
		lines = append(lines, "")
		row(nil, t("check.recommend", map[string]string{"text": recommendationText(v, t, clock)}), nil)
		return finish()
	}
	prob, _ := FormatProbability(v.PHit, o.Display, o.Strings, g)
	interval := ""
	if v.Interval != nil {
		interval = " (" + FormatPercent(v.Interval[0], 1) + g.Dash + FormatPercent(v.Interval[1], 1) + ")"
	}
	lines = append(lines, Fit(t("check.header", map[string]string{
		"state": v.State, "prob": t("prob.read", map[string]string{"prob": prob + interval}), "confidence": t("confidence."+v.Confidence, nil),
	}), w, g.Ellipsis))
	lines = append(lines, strings.Repeat(g.Rule, w))
	if v.Stale {
		secs := t("check.unknown_value", nil)
		for _, d := range v.Drivers {
			if d.Key == "driver.stale" {
				secs = paramString(d.Params["seconds"])
				break
			}
		}
		row(indent(), t("check.stale", map[string]string{"seconds": secs}), nil)
	}

	if v.Mode == "diff" {
		d := v.Diff
		if len(d.Changes) == 0 {
			row(indent(), t("check.no_changes", nil), nil)
		}
		for i, ch := range d.Changes {
			var text string
			if ch.Field == "event" {
				text = t("check.change_event", map[string]string{"event": t("event."+deref(ch.To, ""), nil)})
			} else {
				unknown := t("check.unknown_value", nil)
				text = t("check.change", map[string]string{"field": t("field."+ch.Field, nil), "from": deref(ch.From, unknown), "to": deref(ch.To, unknown)})
			}
			if i == 0 {
				row(lbl("check.label.changes"), text, nil)
			} else {
				row(indent(), text, nil)
			}
		}
		if len(d.MissCauses) > 0 {
			row(indent(), t("check.miss_causes", map[string]string{"causes": causeNames(d.MissCauses, o, t)}), nil)
		}
		return finish()
	}

	if v.LastRequest != nil {
		row(lbl("check.label.last_request"), t("check.last_request", lastRequestParams(v, clock)), tier(v.LastRequest.Tier))
	} else {
		row(lbl("check.label.last_request"), t("check.last_request_none", nil), tier(native.Absent))
	}
	ttl := t("check.ttl_unknown", nil)
	if v.TTL.Value != nil {
		ttl = ttlWords(*v.TTL.Value)
	}
	key, tm := "check.ttl_no_expiry", ""
	if v.ExpiresAt.Value != nil {
		tm = clock(*v.ExpiresAt.Value, false)
		key = "check.ttl_expired"
		if *v.ExpiresAt.Value > v.At {
			key = "check.ttl"
		}
	}
	row(lbl("check.label.ttl"), t(key, map[string]string{"ttl": ttl, "time": tm}), tier(v.ExpiresAt.Tier))
	if verbose {
		at := func(ms *float64) string {
			if ms == nil {
				return t("check.unknown_value", nil)
			}
			return clock(*ms, true)
		}
		drift := "0s"
		if v.Expiry.DriftSec != nil {
			drift = num(*v.Expiry.DriftSec) + "s"
		}
		row(lbl("check.label.expiry"), t("check.expiry", map[string]string{"native": at(v.Expiry.Native), "shield": at(v.Expiry.Shield), "drift": drift}), tier(native.Inferred))
	}
	prefix := t("check.unknown_value", nil)
	if v.PrefixTokens.Value != nil {
		prefix = t("check.prefix", map[string]string{"tokens": FormatTokensLong(*v.PrefixTokens.Value)})
	}
	row(lbl("check.label.prefix"), prefix, tier(v.PrefixTokens.Tier))
	s := v.Session
	session := t("check.session_unknown", nil)
	if s.Requests != nil {
		ratio := t("check.unknown_value", nil)
		if s.HitRatio != nil {
			ratio = FormatPercent(*s.HitRatio, 1)
		}
		misses := 0.0
		if s.Misses != nil {
			misses = *s.Misses
		}
		session = t("check.session", map[string]string{"requests": num(*s.Requests), "ratio": ratio, "misses": num(misses)})
	}
	row(lbl("check.label.session"), session, tier(native.Measured))
	if s.LastMiss != nil {
		at := t("check.unknown_value", nil)
		if s.LastMiss.At != nil {
			at = clock(*s.LastMiss.At, false)
		}
		row(indent(), t("check.last_miss", map[string]string{"time": at, "causes": causeNames(s.LastMiss.Causes, o, t)}), tier(native.Inferred))
	}
	if len(v.Pending) == 0 {
		row(lbl("check.label.pending"), t("check.pending_none", nil), tier(native.Measured))
	}
	for i, p := range v.Pending {
		label := indent()
		if i == 0 {
			label = lbl("check.label.pending")
		}
		row(label, t("check.pending_event", map[string]string{"event": t("event."+p.Kind, nil), "impact": p.Impact}), tier(native.Inferred))
	}

	c := v.Cost
	if c != nil {
		if c.ShowDollars && c.ColdUSD != nil {
			row(lbl("check.label.next_turn"), t("check.next_turn_usd", map[string]string{"warm": usd(c.WarmUSD), "cold": usd(c.ColdUSD)}), tier(native.Estimated))
			row(indent(), t(c.DollarLabel, map[string]string{"date": c.PriceDate}), tier(native.Measured))
		} else {
			k := "check.next_turn_tokens"
			if c.ColdUSD == nil && c.ShowDollars {
				k = "check.next_turn_unknown"
			}
			row(lbl("check.label.next_turn"), t(k, map[string]string{"tokens": FormatTokensLong(c.Tokens)}), tier(native.Inferred))
		}
		if c.PlanShare != nil {
			share := func(sh float64, status string) string {
				if status == "estimated" {
					return toFixed(sh, 1) + "%"
				}
				return ""
			}
			var text string
			if c.PlanShare.Cold.Status == "learning" {
				text = t("check.plan_share_learning", map[string]string{"n": strconv.Itoa(c.PlanShare.Cold.Windows)})
			} else {
				text = t("check.plan_share", map[string]string{"warm": share(c.PlanShare.Warm.Pct, c.PlanShare.Warm.Status), "cold": share(c.PlanShare.Cold.Pct, c.PlanShare.Cold.Status)})
			}
			row(lbl("check.label.plan_share"), text, tier(native.Estimated))
		}
	}

	if len(v.Levers) > 0 {
		lines = append(lines, "", t("check.label.levers", nil))
		nameWidth := 0
		for _, l := range v.Levers {
			if n := width(t("lever."+l.Lever+".name", nil)); n > nameWidth {
				nameWidth = n
			}
		}
		for _, l := range v.Levers {
			mark := " "
			if l.Recommended {
				mark = g.Pick
			}
			params := map[string]string{
				"mark": mark, "name": padEnd(t("lever."+l.Lever+".name", nil), nameWidth), "now": usd(l.NowUSD),
				"turns": strconv.Itoa(levers.HorizonTurns), "horizon": usd(l.HorizonUSD),
			}
			k := "check.lever_now_only"
			if l.HorizonUSD != nil && (l.NowUSD == nil || *l.HorizonUSD != *l.NowUSD) {
				k = "check.lever"
			}
			row(indent(), t(k, params), tier(l.Tier))
			if verbose {
				row(indent(), "    "+t(l.EffectKey, nil), nil)
			}
		}
	}

	if verbose {
		if len(v.Timeline) > 0 {
			lines = append(lines, "", t("check.label.timeline", nil))
			row(indent(), t("check.timeline_head", nil), nil)
			for _, r := range v.Timeline {
				gap := "-"
				if r.GapSec != nil {
					gap = FormatDuration(*r.GapSec)
				}
				cells := padEnd(clock(r.TsStart, true), 10) + padEnd(gap, 9) + padEnd(FormatTokensLong(r.Read), 9) +
					padEnd(FormatTokensLong(r.Write), 9) + padEnd(FormatTokensLong(r.Input), 8) + t("past."+outcomeKey(r.Outcome), nil)
				row(indent(), cells, tier(native.Measured))
			}
		}
		lines = append(lines, "", t("check.label.rationale", nil))
		n := "0"
		for i, d := range v.Drivers {
			params := map[string]string{}
			for k, val := range d.Params {
				params[k] = paramString(val)
			}
			if kind, ok := d.Params["kind"].(string); ok {
				params["kind"] = t("event."+kind, nil)
			}
			if d.Key == "driver.eps" && n == "0" {
				n = paramString(d.Params["n"])
			}
			row(indent(), strconv.Itoa(i+1)+". "+t(d.Key, params), tier(d.Tier))
		}
		k := "check.calibration_learned"
		if v.LowEvidence {
			k = "check.calibration_prior"
		}
		row(lbl("check.label.calibration"), t(k, map[string]string{"n": n}), tier(native.Estimated))
	}

	lines = append(lines, "")
	row(nil, t("check.recommend", map[string]string{"text": recommendationText(v, t, clock)}), tier(native.Estimated))
	if v.Recommendation.ProbeHint {
		var warm, cold *float64
		if c != nil {
			warm, cold = c.WarmUSD, c.ColdUSD
		}
		if cold == nil {
			for _, l := range v.Levers {
				if l.Lever == "probe" {
					cold = l.NowUSD
					break
				}
			}
		}
		row(indent(), t("check.probe_hint", map[string]string{"warm": usd(warm), "cold": usd(cold)}), tier(native.Estimated))
	}
	return finish()
}

// paramString formats a driver or recommendation parameter as String(x) would.
func paramString(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case float64:
		return num(x)
	case int:
		return strconv.Itoa(x)
	default:
		return ""
	}
}

func deref(s *string, fallback string) string {
	if s == nil {
		return fallback
	}
	return *s
}

func lastRequestParams(v View, clock func(float64, bool) string) map[string]string {
	r := v.LastRequest
	return map[string]string{"time": clock(r.TsStart, true), "ago": FormatDuration((v.At - r.TsStart) / 1000)}
}

// causeNames puts Claude Code's miss causes in words, keeping unknown ones as named.
func causeNames(causes []string, o Options, t translator) string {
	out := make([]string, 0, len(causes))
	for _, c := range causes {
		if _, ok := o.Strings.Strings["cause."+c]; ok {
			out = append(out, t("cause."+c, nil))
		} else {
			out = append(out, c)
		}
	}
	return strings.Join(out, ", ")
}

func ttlWords(ttl string) string {
	switch ttl {
	case "1h":
		return "1 hour"
	case "5m":
		return "5 minutes"
	}
	return ttl
}

func outcomeKey(outcome string) string {
	if outcome == "COLD_START" {
		return "cold_start"
	}
	return strings.ToLower(outcome)
}

// viewUnknownReason says why an UNKNOWN view has no state.
func viewUnknownReason(v View, t translator) string {
	reason := ""
	if v.UnknownReason != nil {
		reason = *v.UnknownReason
	}
	return unknownText(reason, v.Drivers, t)
}

// recommendationText is the recommendation as one line.
func recommendationText(v View, t translator, clock func(float64, bool) string) string {
	r := v.Recommendation
	params := map[string]string{}
	for k, val := range r.Params {
		params[k] = paramString(val)
	}
	if e, ok := r.Params["expiresAt"].(float64); ok {
		params["time"] = clock(e, false)
	}
	if u, ok := r.Params["usd"].(float64); ok {
		params["cost"] = FormatUSD(u)
	}
	if l, ok := r.Params["lever"].(string); ok {
		params["lever"] = t("lever."+l+".name", nil)
	}
	if _, ok := r.Params["reason"].(string); ok {
		params["reason"] = viewUnknownReason(v, t)
	}
	params["turns"] = strconv.Itoa(levers.HorizonTurns)
	return t(r.ReasonKey, params)
}
