package render

import (
	"math"
	"strings"

	"github.com/coreyx/claude-token-shield/internal/assess"
	"github.com/coreyx/claude-token-shield/internal/cost"
	"github.com/coreyx/claude-token-shield/internal/data"
)

// Options is what rendering needs besides the content.
type Options struct {
	Glyphs      Glyphs
	Strings     *data.Strings
	Display     data.Display
	TzOffsetMin int
	Billing     string
}

// translator formats catalog strings with the glyph placeholders filled.
type translator func(key string, params map[string]string) string

func (o Options) t() translator {
	return func(key string, params map[string]string) string {
		p := o.Glyphs.params()
		for k, v := range params {
			p[k] = v
		}
		return o.Strings.Format(key, p)
	}
}

// Segment renders the status segment, as renderSegment does in plugin/core/render.
func Segment(a assess.Assessment, c *cost.NextTurn, o Options) string {
	t := o.t()
	tokens := t("check.unknown_value", nil)
	if a.PrefixTokens.Known() {
		tokens = FormatTokensShort(a.PrefixTokens.V)
	}
	timeKnown := a.ExpiresAt.Known()
	clock := ""
	if timeKnown {
		clock = FormatClock(a.ExpiresAt.V, o.TzOffsetMin, false)
	}
	which := "cold"
	if a.State == "EXPIRING" {
		which = "penalty"
	}
	costText, hasCost := rebuildCost(c, o, which)
	prob := ""
	if a.State != "UNKNOWN" {
		prob, _ = FormatProbability(a.PHit, o.Display, o.Strings, o.Glyphs)
	}
	cause := ""
	if a.Cause != nil {
		cause = t("event."+a.Cause.Kind, nil)
	}
	reason := uncertainReason(a, t)
	unknown := unknownText(a.UnknownReason, a.Drivers, t)

	if o.Glyphs.Name == "ascii" {
		parts := []string{}
		if a.State != "UNKNOWN" {
			parts = append(parts, tokens)
		}
		if (a.State == "HOT" || a.State == "EXPIRING") && timeKnown {
			parts = append(parts, "->"+clock)
		}
		if a.State == "UNCERTAIN" {
			parts = append(parts, prob)
		}
		if a.State == "INVALIDATED" {
			parts = append(parts, strings.ReplaceAll(cause, " ", "-"))
		}
		if (a.State == "EXPIRING" || a.State == "INVALIDATED" || a.State == "COLD") && hasCost {
			parts = append(parts, "~"+costText)
		}
		if a.State == "UNKNOWN" {
			parts = append(parts, unknown)
		}
		if a.Stale {
			parts = append(parts, "stale")
		}
		joined := ""
		for _, p := range parts {
			joined += " " + p
		}
		return t("segment.ascii", map[string]string{"state": a.State, "parts": joined})
	}

	glyph := o.Glyphs.State[a.State]
	var line string
	switch a.State {
	case "HOT":
		if timeKnown {
			line = t("segment.HOT", map[string]string{"glyph": glyph, "tokens": tokens, "time": clock})
		} else {
			line = t("segment.HOT.notime", map[string]string{"glyph": glyph, "tokens": tokens})
		}
	case "EXPIRING":
		tm := clock
		if !timeKnown {
			tm = t("check.unknown_value", nil)
		}
		line = t("segment.EXPIRING", map[string]string{"glyph": glyph, "tokens": tokens, "time": tm})
		if hasCost {
			line += t("segment.EXPIRING.cost", map[string]string{"cost": costText})
		}
	case "UNCERTAIN":
		line = t("segment.UNCERTAIN", map[string]string{"glyph": glyph, "reason": reason, "prob": prob})
	case "INVALIDATED":
		line = t("segment.INVALIDATED", map[string]string{"glyph": glyph, "cause": cause, "tokens": tokens})
		if hasCost {
			line += t("segment.cost", map[string]string{"cost": costText})
		}
	case "COLD":
		if timeKnown {
			line = t("segment.COLD", map[string]string{"glyph": glyph, "tokens": tokens, "time": clock})
		} else {
			line = t("segment.COLD.notime", map[string]string{"glyph": glyph, "tokens": tokens})
		}
		if hasCost {
			line += t("segment.cost", map[string]string{"cost": costText})
		}
	default:
		line = t("segment.UNKNOWN", map[string]string{"glyph": glyph, "reason": unknown})
	}
	if a.Stale {
		line += t("segment.stale", nil)
	}
	return line
}

// rebuildCost is the cost as the billing mode shows it: dollars, else a learned plan share.
func rebuildCost(c *cost.NextTurn, o Options, which string) (string, bool) {
	if c == nil {
		return "", false
	}
	if cost.Present(o.Billing, false).Dollars && c.USD != nil {
		if which == "penalty" {
			return FormatUSD(c.USD.Penalty), true
		}
		return FormatUSD(c.USD.Cold), true
	}
	if c.PlanShare != nil && c.PlanShare.Cold.Status == "estimated" {
		return o.Strings.Format("cost.plan_share_short", map[string]string{"pct": num(math.Max(1, jsRound(c.PlanShare.Cold.Pct)))}), true
	}
	return "", false
}

// uncertainReason says in a few words why the state is uncertain.
func uncertainReason(a assess.Assessment, t translator) string {
	for _, p := range a.Pending {
		if p.Impact == "MAY" {
			return t("segment.reason.event", map[string]string{"event": t("event."+p.Event.Kind, nil)})
		}
	}
	if a.RemainingSec != nil && math.Abs(*a.RemainingSec) <= a.MarginSec {
		return t("segment.reason.boundary", nil)
	}
	if a.Stale {
		return t("segment.reason.stale", nil)
	}
	return t("segment.reason.boundary", nil)
}

// unknownText says what an UNKNOWN state is missing.
func unknownText(reason string, drivers []assess.Driver, t translator) string {
	if reason == "version" {
		min := ""
		for _, d := range drivers {
			if d.Key == "driver.version" {
				if m, ok := d.Params["min"].(string); ok {
					min = m
				}
			}
		}
		return t("unknown.version", map[string]string{"version": min})
	}
	if reason == "caching_off" {
		return t("unknown.caching_off", nil)
	}
	return t("unknown.no_response", nil)
}
