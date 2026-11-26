package cli

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/coreyx/claude-token-shield/internal/backfill"
	"github.com/coreyx/claude-token-shield/internal/data"
	"github.com/coreyx/claude-token-shield/internal/render"
)

// onlyFlags reads args as a set of the allowed flags; any other argument is an error.
func onlyFlags(args []string, allowed ...string) (map[string]bool, error) {
	set := map[string]bool{}
	for _, a := range args {
		ok := false
		for _, f := range allowed {
			if a == f {
				ok = true
			}
		}
		if !ok {
			return nil, fmt.Errorf("unknown option %q", a)
		}
		set[a] = true
	}
	return set, nil
}

// backfillCmd reads Claude Code's transcripts, numbers only, for the
// pre-install baseline (REQ-14.0.8, design D17), and reports its coverage.
func backfillCmd(args []string, env Env) int {
	flags, err := onlyFlags(args, "--json")
	if err != nil {
		fmt.Fprintf(env.Stderr, "tshield backfill: %v\n", err)
		return ExitUsage
	}
	d, err := data.Load()
	if err != nil {
		return fail(env, flags["--json"], err)
	}
	p, err := ResolvePaths(env.Getenv)
	if err != nil {
		return fail(env, flags["--json"], err)
	}
	settings, err := settingsPath(env.Getenv)
	if err != nil {
		return fail(env, flags["--json"], err)
	}
	rep, err := backfill.Run(filepath.Join(filepath.Dir(settings), "projects"), p.DataDir, env.Now())
	if errors.Is(err, backfill.ErrBusy) {
		return fail(env, flags["--json"], errors.New(d.Strings.Format("backfill.busy", nil)))
	}
	if err != nil {
		return fail(env, flags["--json"], err)
	}
	text := d.Strings.Format("backfill.done", map[string]string{
		"files": strconv.Itoa(rep.Files), "requests": strconv.Itoa(rep.Requests), "sessions": strconv.Itoa(rep.Sessions),
		"unreadable": strconv.Itoa(rep.Unreadable), "coverage": render.FormatPercent(rep.Coverage, 1),
	})
	return emit(env, flags["--json"], rep, text)
}

// pruneCmd removes history folders whose newest chunk is older than
// historyDays (design D16), as the mod does on start.
func pruneCmd(args []string, env Env) int {
	flags, err := onlyFlags(args, "--json")
	if err != nil {
		fmt.Fprintf(env.Stderr, "tshield prune: %v\n", err)
		return ExitUsage
	}
	d, err := data.Load()
	if err != nil {
		return fail(env, flags["--json"], err)
	}
	p, err := ResolvePaths(env.Getenv)
	if err != nil {
		return fail(env, flags["--json"], err)
	}
	days := configuredHistoryDays(p.Config)
	cutoff := env.Now().Add(-time.Duration(days) * 24 * time.Hour)
	removed := 0
	entries, _ := os.ReadDir(p.History)
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		dir := filepath.Join(p.History, e.Name())
		newest := time.Time{}
		files, _ := filepath.Glob(filepath.Join(dir, "*.json"))
		for _, f := range files {
			if fi, err := os.Stat(f); err == nil && fi.ModTime().After(newest) {
				newest = fi.ModTime()
			}
		}
		if newest.Before(cutoff) {
			if err := os.RemoveAll(dir); err != nil {
				return fail(env, flags["--json"], err)
			}
			removed++
		}
	}
	text := d.Strings.Format("prune.done", map[string]string{"removed": strconv.Itoa(removed), "days": strconv.Itoa(days)})
	return emit(env, flags["--json"], map[string]int{"removed": removed, "historyDays": days}, text)
}

// forgetCmd deletes everything Token Shield stored about sessions:
// history/, sessions/ and backfill/ (REQ-14.0.9). It needs --yes; without
// it, it says what it would delete and changes nothing.
func forgetCmd(args []string, env Env) int {
	flags, err := onlyFlags(args, "--json", "--yes")
	if err != nil {
		fmt.Fprintf(env.Stderr, "tshield forget: %v\n", err)
		return ExitUsage
	}
	d, err := data.Load()
	if err != nil {
		return fail(env, flags["--json"], err)
	}
	p, err := ResolvePaths(env.Getenv)
	if err != nil {
		return fail(env, flags["--json"], err)
	}
	dirs := []string{p.History, p.Sessions, filepath.Join(p.DataDir, "backfill")}
	if !flags["--yes"] {
		fmt.Fprintln(env.Stderr, d.Strings.Format("forget.needs_yes", nil))
		return ExitUsage
	}
	for _, dir := range dirs {
		if err := os.RemoveAll(dir); err != nil {
			return fail(env, flags["--json"], err)
		}
	}
	return emit(env, flags["--json"], map[string]bool{"forgotten": true}, d.Strings.Format("forget.done", nil))
}
