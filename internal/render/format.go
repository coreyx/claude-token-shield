// Package render builds the check view and renders it and the status segment
// as text, mirroring plugin/core/view and plugin/core/render. Output must match
// the TypeScript renderer byte for byte; fixtures/render and fixtures/parity
// hold the two to it.
package render

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/coreyx/claude-token-shield/internal/data"
)

// Glyphs is one rendering style.
type Glyphs struct {
	Name                                                        string
	State                                                       map[string]string
	Rule, Pick, Arrow, Dot, Approx, Ellipsis, Ge, Le, Dash, Eps string
}

// Unicode and ASCII are the two glyph sets (REQ-22.0.1).
var (
	Unicode = Glyphs{
		Name:  "unicode",
		State: map[string]string{"HOT": "●", "EXPIRING": "◐", "UNCERTAIN": "◌", "INVALIDATED": "✕", "COLD": "○", "UNKNOWN": "?"},
		Rule:  "─", Pick: "▶", Arrow: "→", Dot: "·", Approx: "≈", Ellipsis: "…", Ge: "≥", Le: "≤", Dash: "–", Eps: "ε",
	}
	ASCII = Glyphs{
		Name:  "ascii",
		State: map[string]string{"HOT": "*", "EXPIRING": "~", "UNCERTAIN": "?", "INVALIDATED": "x", "COLD": "o", "UNKNOWN": "?"},
		Rule:  "-", Pick: ">", Arrow: "->", Dot: "|", Approx: "~", Ellipsis: "...", Ge: ">=", Le: "<=", Dash: "-", Eps: "eps",
	}
)

// GlyphSet returns the set for a configured style.
func GlyphSet(style string) Glyphs {
	if style == "ascii" {
		return ASCII
	}
	return Unicode
}

// params fills the catalog's glyph placeholders.
func (g Glyphs) params() map[string]string {
	return map[string]string{"dot": g.Dot, "approx": g.Approx, "arrow": g.Arrow, "ge": g.Ge, "le": g.Le, "dash": g.Dash, "epsilon": g.Eps}
}

// jsRound rounds like JavaScript's Math.round: halves go toward +Infinity.
func jsRound(x float64) float64 { return math.Floor(x + 0.5) }

// num formats a number as JavaScript's String(n) does for the values the
// catalog receives: integers without a decimal point, others in shortest form.
func num(x float64) string {
	if x == math.Trunc(x) && math.Abs(x) < 1e15 {
		return strconv.FormatInt(int64(x), 10)
	}
	return strconv.FormatFloat(x, 'f', -1, 64)
}

// toFixed formats x with d decimals, as JavaScript's toFixed does for the
// magnitudes rendered here.
func toFixed(x float64, d int) string { return strconv.FormatFloat(x, 'f', d, 64) }

func two(n int) string { return fmt.Sprintf("%02d", n) }

// FormatClock is a wall-clock time at a fixed offset from UTC.
func FormatClock(ms float64, tzOffsetMin int, seconds bool) string {
	t := time.UnixMilli(int64(ms) + int64(tzOffsetMin)*60_000).UTC()
	hm := two(t.Hour()) + ":" + two(t.Minute())
	if seconds {
		return hm + ":" + two(t.Second())
	}
	return hm
}

// FormatDuration is a duration: 45s, 12m, 59m 48s, 2h 05m.
func FormatDuration(totalSec float64) string {
	s := int(math.Max(0, jsRound(totalSec)))
	if s < 60 {
		return fmt.Sprintf("%ds", s)
	}
	if s < 3600 {
		m, rest := s/60, s%60
		if rest == 0 {
			return fmt.Sprintf("%dm", m)
		}
		return fmt.Sprintf("%dm %ss", m, two(rest))
	}
	return fmt.Sprintf("%dh %sm", s/3600, two((s%3600)/60))
}

// FormatTokensShort is tokens in short form: 950, 812k, 1.2M.
func FormatTokensShort(n float64) string {
	if n < 1000 {
		return num(jsRound(n))
	}
	if n < 1_000_000 {
		return num(jsRound(n/1000)) + "k"
	}
	return toFixed(jsRound(n/100_000)/10, 1) + "M"
}

var thousands = regexp.MustCompile(`(\d)(\d{3})($|,)`)

// FormatTokensLong is tokens with thousands separators: 812,470.
func FormatTokensLong(n float64) string {
	s := num(jsRound(n))
	for {
		next := thousands.ReplaceAllString(s, "$1,$2$3")
		if next == s {
			return s
		}
		s = next
	}
}

// FormatUSD is dollars to the cent; below a cent, <$0.01.
func FormatUSD(usd float64) string {
	if usd > 0 && usd < 0.005 {
		return "<$0.01"
	}
	return "$" + toFixed(usd, 2)
}

// FormatPercent is a 0–1 fraction as a percentage.
func FormatPercent(fraction float64, digits int) string {
	return toFixed(fraction*100, digits) + "%"
}

// width counts characters as the TypeScript renderer does (UTF-16 units,
// which equal runes for every glyph used).
func width(s string) int { return utf8.RuneCountInString(s) }

// Fit cuts text to a width with an ellipsis.
func Fit(text string, w int, ellipsis string) string {
	if width(text) <= w {
		return text
	}
	r := []rune(text)
	if w <= width(ellipsis) {
		return string(r[:w])
	}
	return string(r[:w-width(ellipsis)]) + ellipsis
}

// padEnd pads s with spaces to w characters.
func padEnd(s string, w int) string {
	if n := width(s); n < w {
		return s + strings.Repeat(" ", w-n)
	}
	return s
}

// FormatProbability formats a probability within the display caps; ok is
// false when there is none to show.
func FormatProbability(p *float64, display data.Display, s *data.Strings, g Glyphs) (string, bool) {
	if p == nil || math.IsNaN(*p) || math.IsInf(*p, 0) {
		return "", false
	}
	gp := g.params()
	if *p >= display.MaxProb {
		gp["pct"] = num(jsRound(display.MaxProb * 100))
		return s.Format("prob.at_least", gp), true
	}
	if *p <= display.MinProb {
		gp["pct"] = num(jsRound(display.MinProb * 100))
		return s.Format("prob.at_most", gp), true
	}
	pct := math.Min(jsRound(display.MaxProb*100), math.Max(jsRound(display.MinProb*100), jsRound(*p*100)))
	return s.Format("prob.about", map[string]string{"pct": num(pct)}), true
}

// FormatStamp is a date and wall-clock time without the year, `01-29 14:10`,
// for history rows that span days.
func FormatStamp(ms float64, tzOffsetMin int) string {
	t := time.UnixMilli(int64(ms) + int64(tzOffsetMin)*60_000).UTC()
	return two(int(t.Month())) + "-" + two(t.Day()) + " " + two(t.Hour()) + ":" + two(t.Minute())
}

// padStart pads s with spaces on the left to w characters.
func padStart(s string, w int) string {
	if n := width(s); n < w {
		return strings.Repeat(" ", w-n) + s
	}
	return s
}
