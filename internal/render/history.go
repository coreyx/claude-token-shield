package render

import (
	"strconv"
	"strings"

	"github.com/coreyx/claude-token-shield/internal/summary"
)

// MaxHistoryRows is how many of the most recent rows are shown; older ones are counted instead.
const MaxHistoryRows = 30

// causeLabel is the width of the cause labels in the by-cause lines.
const causeLabel = 32

// RenderHistory renders a history summary at a width, with the advice line
// when a report is given (plugin/core/render/history.ts).
func RenderHistory(s summary.Summary, w int, o Options, advice *summary.AdviceReport) string {
	g := o.Glyphs
	t := func(key string, params map[string]string) string {
		all := g.params()
		for k, v := range params {
			all[k] = v
		}
		return o.Strings.Format(key, all)
	}
	stamp := func(ms float64) string { return FormatStamp(ms, o.TzOffsetMin) }
	itoa := strconv.Itoa
	lines := []string{t("history.title", map[string]string{"from": stamp(s.Range.From), "to": stamp(s.Range.To), "sessions": itoa(s.Sessions), "requests": itoa(s.Requests)})}

	if s.Requests == 0 {
		lines = append(lines, t("history.none", nil))
	} else {
		lines = append(lines, t("history.recache", map[string]string{"usd": FormatUSD(s.RecacheUSD), "count": itoa(s.Recaches), "tokens": FormatTokensLong(s.RecacheTokens)}))
		for _, c := range summary.Causes {
			total := s.ByCause[c]
			if total == nil || total.Count == 0 {
				continue
			}
			lines = append(lines, t("history.cause_row", map[string]string{"cause": padEnd(t("history.cause."+c, nil), causeLabel), "usd": FormatUSD(total.USD), "count": itoa(total.Count)}))
		}
		lines = append(lines, t("history.avoidable", map[string]string{"usd": FormatUSD(s.AvoidableUSD), "count": itoa(s.AvoidableCount)}))
		if s.Unpriced > 0 {
			lines = append(lines, t("history.unpriced", map[string]string{"count": itoa(s.Unpriced)}))
		}
		if advice != nil {
			if advice.Share != nil {
				lines = append(lines, t("history.advice", map[string]string{"cheapest": itoa(advice.Cheapest), "n": itoa(advice.Evaluated), "share": FormatPercent(*advice.Share, 0)}))
			} else {
				lines = append(lines, t("history.advice_none", map[string]string{"unevaluated": itoa(advice.Unevaluated)}))
			}
		}
		if len(s.Rows) > 0 {
			lines = append(lines, "", t("history.rows_header", nil))
			shown := s.Rows
			if len(shown) > MaxHistoryRows {
				shown = shown[len(shown)-MaxHistoryRows:]
				lines = append(lines, t("history.earlier", map[string]string{"count": itoa(len(s.Rows) - len(shown))}))
			}
			for _, r := range shown {
				session := r.Session
				if len(session) > 8 {
					session = session[:8]
				}
				cause := ""
				if r.Cause != nil {
					cause = t("history.cause_short."+*r.Cause, nil)
				}
				usd := "?"
				if r.RecacheUSD != nil {
					usd = FormatUSD(*r.RecacheUSD)
				}
				line := padEnd(stamp(r.Ts), 13) + padEnd(session, 10) + padEnd(r.Model, 21) + padEnd(t("history.outcome."+r.Outcome, nil), 9) +
					padEnd(cause, 14) + padStart(FormatTokensLong(r.RecacheTokens), 7) + padStart(usd, 10)
				if r.Avoidable {
					line += "  " + t("history.avoidable_mark", nil)
				}
				lines = append(lines, line)
			}
		}
	}
	if s.SkippedChunks > 0 {
		lines = append(lines, "", t("history.skipped", map[string]string{"count": itoa(s.SkippedChunks)}))
	}
	for i, l := range lines {
		lines[i] = Fit(l, w, g.Ellipsis)
	}
	return strings.Join(lines, "\n")
}

// RenderCalibration renders calibration (plugin/core/render/history.ts).
func RenderCalibration(c summary.Calibration, minCalibrationN, w int, o Options) string {
	g := o.Glyphs
	t := func(key string, params map[string]string) string {
		all := g.params()
		for k, v := range params {
			all[k] = v
		}
		return o.Strings.Format(key, all)
	}
	if c.N == 0 {
		return Fit(t("calibration.none", nil), w, g.Ellipsis)
	}
	brier := 0.0
	if c.Brier != nil {
		brier = *c.Brier
	}
	orDash := func(p *string) string {
		if p == nil {
			return "-"
		}
		return *p
	}
	lines := []string{t("calibration.title", map[string]string{"n": strconv.Itoa(c.N), "brier": toFixed(brier, 4)}), "", t("calibration.header", nil)}
	for _, b := range c.Buckets {
		lines = append(lines, padEnd(b.State, 13)+padEnd(orDash(b.TTL), 5)+padEnd(t("calibration.band."+b.Band, nil), 12)+
			padStart(strconv.Itoa(b.N), 3)+padStart(FormatPercent(b.MeanPredicted, 1), 11)+padStart(FormatPercent(b.Observed, 1), 10)+
			"  "+FormatPercent(b.Wilson[0], 1)+g.Dash+FormatPercent(b.Wilson[1], 1))
	}
	lines = append(lines, "", t("calibration.brier_title", nil))
	for _, b := range c.BrierBy {
		lines = append(lines, "  "+padEnd(orDash(b.CCVersion), 10)+padEnd(orDash(b.Model), 21)+padEnd(orDash(b.TTL), 5)+"n "+padEnd(strconv.Itoa(b.N), 6)+toFixed(b.Brier, 4))
	}
	if c.Drift {
		lines = append(lines, "", t("calibration.drift", map[string]string{"observed": FormatPercent(*c.Hot.MissRate, 1), "stated": FormatPercent(*c.Hot.StatedUpper, 1)}))
	} else if c.Hot.N < minCalibrationN {
		lines = append(lines, "", t("calibration.priors", map[string]string{"n": strconv.Itoa(c.Hot.N), "min": strconv.Itoa(minCalibrationN)}))
	}
	for i, l := range lines {
		lines[i] = Fit(l, w, g.Ellipsis)
	}
	return strings.Join(lines, "\n")
}
