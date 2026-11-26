package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"

	"github.com/coreyx/claude-token-shield/internal/bridge"
	"github.com/coreyx/claude-token-shield/internal/data"
	"github.com/coreyx/claude-token-shield/internal/history"
	"github.com/coreyx/claude-token-shield/internal/render"
	"github.com/coreyx/claude-token-shield/internal/store"
	"github.com/coreyx/claude-token-shield/internal/summary"
)

// historyArgs are tshield history's options.
type historyArgs struct {
	session string
	all     bool
	since   string
	misses  bool
	json    bool
}

func parseHistory(args []string) (historyArgs, error) {
	var a historyArgs
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--all":
			a.all = true
		case "--misses":
			a.misses = true
		case "--json":
			a.json = true
		case "--session", "--since":
			if i+1 >= len(args) {
				return a, fmt.Errorf("%s needs a value", args[i])
			}
			if args[i] == "--session" {
				a.session = args[i+1]
			} else {
				a.since = args[i+1]
			}
			i++
		default:
			return a, fmt.Errorf("unknown option %q", args[i])
		}
	}
	if a.all && a.session != "" {
		return a, fmt.Errorf("--all and --session can't be combined")
	}
	return a, nil
}

// historyCmd summarizes the history of the newest session, a named one, or
// all of them, in a window (AC 6.5, 14.1, 14.2). It reads files only.
func historyCmd(args []string, env Env) int {
	for _, arg := range args {
		if arg == "--calibration" {
			return calibrationCmd(args, env)
		}
	}
	a, err := parseHistory(args)
	if err != nil {
		fmt.Fprintf(env.Stderr, "tshield history: %v\n", err)
		return ExitUsage
	}
	now := float64(env.Now().UnixMilli())
	rng, ok := summary.SinceRange(a.since, now)
	if !ok {
		fmt.Fprintf(env.Stderr, "tshield history: --since takes a number of days or hours, such as 7d or 12h\n")
		return ExitUsage
	}
	d, err := data.Load()
	if err != nil {
		return fail(env, a.json, err)
	}
	p, err := ResolvePaths(env.Getenv)
	if err != nil {
		return fail(env, a.json, err)
	}
	var ids []string
	switch {
	case a.all:
		ids = historySessions(p.History)
	case a.session != "":
		ids = []string{a.session}
	default:
		if id := newestSession(p.Sessions); id != "" {
			ids = []string{id}
		} else if all := historySessions(p.History); len(all) > 0 {
			ids = all[len(all)-1:]
		}
	}
	sessions := make([]summary.SessionHistory, 0, len(ids))
	for _, id := range ids {
		h := history.ReadSession(p.History, id)
		sessions = append(sessions, summary.SessionHistory{SessionID: id, Requests: h.Requests, Events: h.Events, Recommendations: h.Recommendations, Levers: h.Levers, Skipped: h.Skipped})
	}
	filter := summary.Filter{Misses: a.misses}
	s := summary.Summarize(sessions, rng, filter, &d.Prices, bridge.Provider(env.Getenv))
	advice := summary.Advice(sessions, rng, filter, &d.Prices)
	if a.json {
		return emit(env, true, struct {
			summary.Summary
			Advice summary.AdviceReport `json:"advice"`
		}{s, advice}, "")
	}
	opts := render.Options{Glyphs: render.GlyphSet(configuredGlyphs(p.Config)), Strings: &d.Strings, Display: d.Rules.Display, TzOffsetMin: env.tzOffset()}
	return emit(env, false, nil, render.RenderHistory(s, columns(env.Getenv), opts, &advice))
}

// historySessions lists the sessions with history, oldest change first.
func historySessions(historyDir string) []string {
	entries, err := os.ReadDir(historyDir)
	if err != nil {
		return nil
	}
	type dated struct {
		id  string
		mod int64
	}
	found := []dated{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		var newest int64
		files, _ := filepath.Glob(filepath.Join(historyDir, e.Name(), "*.json"))
		for _, f := range files {
			if fi, err := os.Stat(f); err == nil && fi.ModTime().UnixNano() > newest {
				newest = fi.ModTime().UnixNano()
			}
		}
		found = append(found, dated{e.Name(), newest})
	}
	sort.SliceStable(found, func(a, b int) bool { return found[a].mod < found[b].mod })
	ids := make([]string, len(found))
	for i, f := range found {
		ids[i] = f.id
	}
	return ids
}

// configuredHistoryDays is the history window from the mirrored config, else 90 days.
func configuredHistoryDays(path string) int {
	raw, err := store.ReadFile(path)
	if err != nil {
		return 90
	}
	var c struct {
		HistoryDays int `json:"historyDays"`
	}
	if json.Unmarshal(raw, &c) != nil || c.HistoryDays <= 0 {
		return 90
	}
	return c.HistoryDays
}

// calibrationCmd prints calibration across every session's recorded
// predictions in the window (REQ-14.0.5): `tshield calibration [--since 30d] [--json]`,
// also reached as `tshield history --calibration`.
func calibrationCmd(args []string, env Env) int {
	since, asJSON := "", false
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--json":
			asJSON = true
		case "--calibration":
		case "--since":
			if i+1 >= len(args) {
				fmt.Fprintln(env.Stderr, "tshield calibration: --since needs a value")
				return ExitUsage
			}
			i++
			since = args[i]
		default:
			fmt.Fprintf(env.Stderr, "tshield calibration: unknown option %q\n", args[i])
			return ExitUsage
		}
	}
	d, err := data.Load()
	if err != nil {
		return fail(env, asJSON, err)
	}
	p, err := ResolvePaths(env.Getenv)
	if err != nil {
		return fail(env, asJSON, err)
	}
	now := float64(env.Now().UnixMilli())
	if since == "" {
		since = strconv.Itoa(configuredHistoryDays(p.Config)) + "d"
	}
	rng, ok := summary.SinceRange(since, now)
	if !ok {
		fmt.Fprintln(env.Stderr, "tshield calibration: --since takes a number of days or hours, such as 30d or 12h")
		return ExitUsage
	}
	records := []summary.AssessmentRecord{}
	for _, id := range historySessions(p.History) {
		for _, a := range history.ReadSession(p.History, id).Assessments {
			if a.Ts >= rng.From && a.Ts <= rng.To {
				records = append(records, a)
			}
		}
	}
	sort.SliceStable(records, func(a, b int) bool { return records[a].Ts < records[b].Ts })
	pr := d.Rules.Priors
	c := summary.Calibrate(records, summary.Priors{EpsWithin: pr.EpsWithin, EpsAfter: pr.EpsAfter, MinCalibrationN: pr.MinCalibrationN})
	if asJSON {
		return emit(env, true, c, "")
	}
	opts := render.Options{Glyphs: render.GlyphSet(configuredGlyphs(p.Config)), Strings: &d.Strings, Display: d.Rules.Display, TzOffsetMin: env.tzOffset()}
	return emit(env, false, nil, render.RenderCalibration(c, pr.MinCalibrationN, columns(env.Getenv), opts))
}

// ttlCmd prints the TTL advisor across every session in the window
// (REQ-16): `tshield ttl [--since 30d] [--json]`. Changing the setting is the
// mod's, through its confirmation, so the text ends with how to apply it there.
func ttlCmd(args []string, env Env) int {
	since, asJSON := "", false
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--json":
			asJSON = true
		case "--since":
			if i+1 >= len(args) {
				fmt.Fprintln(env.Stderr, "tshield ttl: --since needs a value")
				return ExitUsage
			}
			i++
			since = args[i]
		default:
			fmt.Fprintf(env.Stderr, "tshield ttl: unknown option %q\n", args[i])
			return ExitUsage
		}
	}
	now := float64(env.Now().UnixMilli())
	rng, ok := summary.SinceRange(since, now)
	if !ok {
		fmt.Fprintln(env.Stderr, "tshield ttl: --since takes a number of days or hours, such as 30d or 12h")
		return ExitUsage
	}
	d, err := data.Load()
	if err != nil {
		return fail(env, asJSON, err)
	}
	p, err := ResolvePaths(env.Getenv)
	if err != nil {
		return fail(env, asJSON, err)
	}
	sessions := []summary.SessionHistory{}
	for _, id := range historySessions(p.History) {
		h := history.ReadSession(p.History, id)
		sessions = append(sessions, summary.SessionHistory{SessionID: id, Requests: h.Requests})
	}
	a := summary.AdviseTTL(sessions, rng, &d.Prices, bridge.Provider(env.Getenv))
	if asJSON {
		return emit(env, true, a, "")
	}
	opts := render.Options{Glyphs: render.GlyphSet(configuredGlyphs(p.Config)), Strings: &d.Strings, Display: d.Rules.Display, TzOffsetMin: env.tzOffset()}
	text := render.RenderTTLAdvice(a, columns(env.Getenv), opts)
	for _, b := range []struct {
		bucket summary.TTLBucket
		flag   string
	}{{a.Main, ""}, {a.Subagent, " --subagent"}} {
		if b.bucket.Recommended != nil {
			text += "\n" + d.Strings.Format("ttl.apply", map[string]string{"ttl": *b.bucket.Recommended, "subagent": b.flag})
		}
	}
	return emit(env, false, nil, text)
}
