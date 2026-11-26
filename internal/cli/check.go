package cli

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/coreyx/claude-token-shield/internal/assess"
	"github.com/coreyx/claude-token-shield/internal/bridge"
	"github.com/coreyx/claude-token-shield/internal/data"
	"github.com/coreyx/claude-token-shield/internal/history"
	"github.com/coreyx/claude-token-shield/internal/native"
	"github.com/coreyx/claude-token-shield/internal/render"
	"github.com/coreyx/claude-token-shield/internal/store"
)

// checkArgs are tshield check's options.
type checkArgs struct {
	mode    string
	session string
	json    bool
	probe   bool
}

func parseCheck(args []string) (checkArgs, error) {
	a := checkArgs{mode: "default"}
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--verbose":
			a.mode = "verbose"
		case "--diff":
			a.mode = "diff"
		case "--probe":
			a.probe = true
		case "--json":
			a.json = true
		case "--session":
			if i+1 >= len(args) {
				return a, fmt.Errorf("--session needs an id")
			}
			i++
			a.session = args[i]
		default:
			return a, fmt.Errorf("unknown option %q", args[i])
		}
	}
	return a, nil
}

// check assesses the newest (or the named) session from its snapshot and
// history, and exits with the state's code (REQ-19.0.3). It reads files only:
// no network, no model request.
func check(args []string, env Env) int {
	a, err := parseCheck(args)
	if err != nil {
		fmt.Fprintf(env.Stderr, "tshield check: %v\n", err)
		return ExitUsage
	}
	d, err := data.Load()
	if err != nil {
		return fail(env, a.json, err)
	}
	if a.probe {
		// A probe must resend the session's exact prefix, which only the mod's
		// $.model.fork can do; this command makes no request at all (AC 7.4).
		msg := d.Strings.Format("error.probe_needs_mod", nil)
		if a.json {
			b, _ := json.Marshal(map[string]string{"error": msg})
			fmt.Fprintln(env.Stdout, string(b))
		} else {
			fmt.Fprintln(env.Stdout, msg)
		}
		return ExitUsage
	}
	p, err := ResolvePaths(env.Getenv)
	if err != nil {
		return fail(env, a.json, err)
	}
	id := a.session
	if id == "" {
		id = newestSession(p.Sessions)
	}

	state := native.State{}
	if id != "" {
		for _, f := range history.ReadSession(p.History, id).Facts() {
			state = native.Reduce(state, f)
		}
		if snap, ok := readSnapshot(filepath.Join(p.Sessions, id, "snapshot.json")); ok {
			state = native.Reduce(state, native.Fact{Snapshot: &snap})
		}
	}
	if state.LastSnapshot == nil {
		fmt.Fprintln(env.Stderr, d.Strings.Format("error.bridge_unavailable", nil))
	}

	now := float64(env.Now().UnixMilli())
	ev := render.Evaluate(state, now, render.Context{Data: d, Env: assess.Env{Provider: bridge.Provider(env.Getenv), ToolSearch: true}, Mode: a.mode})
	code := render.ExitCodes[ev.A.State]
	if a.json {
		b, err := json.Marshal(ev.View)
		if err != nil {
			return fail(env, true, err)
		}
		fmt.Fprintln(env.Stdout, string(b))
		return code
	}
	opts := render.Options{Glyphs: render.GlyphSet(configuredGlyphs(p.Config)), Strings: &d.Strings, Display: d.Rules.Display, TzOffsetMin: env.tzOffset(), Billing: ev.Billing}
	fmt.Fprintln(env.Stdout, render.Check(ev.View, columns(env.Getenv), opts))
	if a.mode == "verbose" {
		// tshield sees only files; events the mod observes live are missing here.
		fmt.Fprintln(env.Stdout, "\n"+d.Strings.Format("check.cli_gap", nil))
	}
	return code
}

// newestSession is the session whose snapshot changed last.
func newestSession(sessionsDir string) string {
	entries, err := os.ReadDir(sessionsDir)
	if err != nil {
		return ""
	}
	best, bestTime := "", time.Time{}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		fi, err := os.Stat(filepath.Join(sessionsDir, e.Name(), "snapshot.json"))
		if err == nil && fi.ModTime().After(bestTime) {
			best, bestTime = e.Name(), fi.ModTime()
		}
	}
	return best
}

// readSnapshot loads the bridge's snapshot.json.
func readSnapshot(path string) (native.Snapshot, bool) {
	raw, err := store.ReadFile(path)
	if err != nil {
		return native.Snapshot{}, false
	}
	var f bridge.File
	if json.Unmarshal(raw, &f) != nil || f.V > bridge.SnapshotFormat {
		return native.Snapshot{}, false
	}
	return native.ParseSnapshotMap(f.Payload, f.ReceivedAt), true
}

// configuredGlyphs reads the glyph set from the mod's config mirror.
func configuredGlyphs(path string) string {
	raw, err := store.ReadFile(path)
	if err != nil {
		return "unicode"
	}
	var c struct {
		Glyphs string `json:"glyphs"`
	}
	if json.Unmarshal(raw, &c) != nil || c.Glyphs != "ascii" {
		return "unicode"
	}
	return "ascii"
}

// columns is the terminal width from COLUMNS, else 100.
func columns(getenv func(string) string) int {
	if n, err := strconv.Atoi(getenv("COLUMNS")); err == nil && n >= 40 {
		return n
	}
	return 100
}
