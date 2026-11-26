// Package cli implements the tshield command (requirements REQ-19). Each
// subcommand writes text or, with --json, one JSON object, and returns the
// process exit code; cmd/tshield only wires it to the real process.
package cli

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/coreyx/claude-token-shield/internal/data"
	"github.com/coreyx/claude-token-shield/internal/store"
	"github.com/coreyx/claude-token-shield/internal/version"
)

// Env is the process environment a command runs in, injectable for tests.
type Env struct {
	Stdin          io.Reader
	Stdout, Stderr io.Writer
	Getenv         func(string) string
	// Executable is the running binary's path, for self-install.
	Executable func() (string, error)
	Now        func() time.Time
	// TzOffsetMin is minutes east of UTC for wall-clock times; nil means the local zone.
	TzOffsetMin func() int
	// ManagedSettings overrides where managed settings are looked for; nil means the platform paths.
	ManagedSettings []string
}

// tzOffset is the zone offset to render times in.
func (e Env) tzOffset() int {
	if e.TzOffsetMin != nil {
		return e.TzOffsetMin()
	}
	_, off := e.Now().Zone()
	return off / 60
}

// RealEnv is the environment of the running process.
func RealEnv() Env {
	return Env{Stdin: os.Stdin, Stdout: os.Stdout, Stderr: os.Stderr, Getenv: os.Getenv, Executable: os.Executable, Now: time.Now}
}

// Exit codes outside the check states (REQ-19.0.3 reserves 0–50 for those).
const (
	ExitOK    = 0
	ExitUsage = 2
	ExitError = 1
)

const usage = `usage: tshield <command> [--json]

commands:
  check          the cache state of the newest session [--verbose|--diff|--probe] [--session <id>]
  version        the companions' version
  paths          where Token Shield keeps its data
  setup          point Claude Code's statusline at the bridge [--undo] [--yes]
  self-install   copy these binaries into the data directory`

// Run runs one command line (without the program name) and returns the exit code.
func Run(args []string, env Env) int {
	if len(args) == 0 {
		fmt.Fprintln(env.Stderr, usage)
		return ExitUsage
	}
	cmd, rest := args[0], args[1:]
	switch cmd {
	case "check":
		return check(rest, env)
	case "setup":
		return setup(rest, env)
	}
	asJSON := false
	for _, a := range rest {
		if a == "--json" {
			asJSON = true
		}
	}
	switch cmd {
	case "version":
		return versionCmd(env, asJSON)
	case "paths":
		return pathsCmd(env, asJSON)
	case "self-install":
		return selfInstall(env, asJSON)
	case "help", "-h", "--help":
		fmt.Fprintln(env.Stdout, usage)
		return ExitOK
	default:
		fmt.Fprintf(env.Stderr, "tshield: unknown command %q\n%s\n", cmd, usage)
		return ExitUsage
	}
}

// emit writes v as JSON, or text as given.
func emit(env Env, asJSON bool, v any, text string) int {
	if asJSON {
		b, err := json.Marshal(v)
		if err != nil {
			fmt.Fprintln(env.Stderr, "tshield:", err)
			return ExitError
		}
		fmt.Fprintln(env.Stdout, string(b))
		return ExitOK
	}
	fmt.Fprintln(env.Stdout, text)
	return ExitOK
}

// fail reports an error the same way in both output modes.
func fail(env Env, asJSON bool, err error) int {
	if asJSON {
		b, _ := json.Marshal(map[string]string{"error": err.Error()})
		fmt.Fprintln(env.Stdout, string(b))
	}
	fmt.Fprintln(env.Stderr, "tshield:", err)
	return ExitError
}

func versionCmd(env Env, asJSON bool) int {
	v := map[string]any{"version": version.Version, "os": runtime.GOOS, "arch": runtime.GOARCH, "dataVersion": data.Version}
	return emit(env, asJSON, v, version.Version)
}

// Paths are the data directory's layout (design.md "Data model").
type Paths struct {
	DataDir  string `json:"dataDir"`
	Sessions string `json:"sessions"`
	History  string `json:"history"`
	Bin      string `json:"bin"`
	Config   string `json:"config"`
	Bridge   string `json:"bridge"`
}

// ResolvePaths lays out the data directory for an environment.
func ResolvePaths(getenv func(string) string) (Paths, error) {
	dir, err := store.DataDir(getenv)
	if err != nil {
		return Paths{}, err
	}
	return Paths{
		DataDir:  dir,
		Sessions: filepath.Join(dir, "sessions"),
		History:  filepath.Join(dir, "history"),
		Bin:      filepath.Join(dir, "bin"),
		Config:   filepath.Join(dir, "config.json"),
		Bridge:   filepath.Join(dir, "bridge.json"),
	}, nil
}

func pathsCmd(env Env, asJSON bool) int {
	p, err := ResolvePaths(env.Getenv)
	if err != nil {
		return fail(env, asJSON, err)
	}
	return emit(env, asJSON, p, p.DataDir)
}

// BinaryNames are the companion binaries for this platform.
func BinaryNames() []string {
	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}
	return []string{"tshield" + ext, "tshield-statusline" + ext}
}

// selfInstall copies both binaries next to the running one into <data>/bin,
// so a configured statusline path survives plugin updates (design D14).
func selfInstall(env Env, asJSON bool) int {
	p, err := ResolvePaths(env.Getenv)
	if err != nil {
		return fail(env, asJSON, err)
	}
	exe, err := env.Executable()
	if err != nil {
		return fail(env, asJSON, err)
	}
	installed, err := store.Install(filepath.Dir(exe), p.Bin, BinaryNames(), env.Now())
	if err != nil {
		return fail(env, asJSON, err)
	}
	return emit(env, asJSON, map[string]any{"installed": installed, "version": version.Version}, fmt.Sprintf("installed %d binaries in %s", len(installed), p.Bin))
}
