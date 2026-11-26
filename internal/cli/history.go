package cli

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/coreyx/claude-token-shield/internal/bridge"
	"github.com/coreyx/claude-token-shield/internal/data"
	"github.com/coreyx/claude-token-shield/internal/history"
	"github.com/coreyx/claude-token-shield/internal/render"
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
		sessions = append(sessions, summary.SessionHistory{SessionID: id, Requests: h.Requests, Events: h.Events, Skipped: h.Skipped})
	}
	s := summary.Summarize(sessions, rng, summary.Filter{Misses: a.misses}, &d.Prices, bridge.Provider(env.Getenv))
	if a.json {
		return emit(env, true, s, "")
	}
	opts := render.Options{Glyphs: render.GlyphSet(configuredGlyphs(p.Config)), Strings: &d.Strings, Display: d.Rules.Display, TzOffsetMin: env.tzOffset()}
	return emit(env, false, nil, render.RenderHistory(s, columns(env.Getenv), opts))
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
