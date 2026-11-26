package cli

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// testEnv captures output and fixes the environment.
func testEnv(vars map[string]string) (Env, *bytes.Buffer, *bytes.Buffer) {
	var out, errOut bytes.Buffer
	return Env{
		Stdout: &out, Stderr: &errOut,
		Getenv:     func(k string) string { return vars[k] },
		Executable: func() (string, error) { return "", errors.New("no executable in tests") },
		Now:        func() time.Time { return time.Unix(1, 0) },
	}, &out, &errOut
}

func TestVersionJSON(t *testing.T) {
	env, out, _ := testEnv(nil)
	if code := Run([]string{"version", "--json"}, env); code != ExitOK {
		t.Fatalf("exit %d", code)
	}
	var v map[string]any
	if err := json.Unmarshal(out.Bytes(), &v); err != nil || v["version"] != "dev" || v["os"] != runtime.GOOS || v["dataVersion"] != 1.0 {
		t.Errorf("version: %s (%v)", out, err)
	}
	env, out, _ = testEnv(nil)
	Run([]string{"version"}, env)
	if strings.TrimSpace(out.String()) != "dev" {
		t.Errorf("text version: %q", out)
	}
}

func TestPathsHonorsHome(t *testing.T) {
	home := filepath.Join(t.TempDir(), "shield")
	env, out, _ := testEnv(map[string]string{"TOKEN_SHIELD_HOME": home})
	if code := Run([]string{"paths", "--json"}, env); code != ExitOK {
		t.Fatalf("exit %d", code)
	}
	var p Paths
	if err := json.Unmarshal(out.Bytes(), &p); err != nil || p.DataDir != home || p.Bin != filepath.Join(home, "bin") || p.Bridge != filepath.Join(home, "bridge.json") {
		t.Errorf("paths: %s", out)
	}
}

func TestUsage(t *testing.T) {
	env, _, errOut := testEnv(nil)
	if Run(nil, env) != ExitUsage || !strings.Contains(errOut.String(), "usage") {
		t.Error("no command should print usage")
	}
	env, _, errOut = testEnv(nil)
	if Run([]string{"frobnicate"}, env) != ExitUsage || !strings.Contains(errOut.String(), "unknown command") {
		t.Error("unknown command")
	}
	env, out, _ := testEnv(nil)
	if Run([]string{"--help"}, env) != ExitOK || !strings.Contains(out.String(), "self-install") {
		t.Error("help")
	}
}

func TestSelfInstall(t *testing.T) {
	src, home := t.TempDir(), t.TempDir()
	for _, n := range BinaryNames() {
		_ = os.WriteFile(filepath.Join(src, n), []byte(n), 0o755)
	}
	env, out, _ := testEnv(map[string]string{"TOKEN_SHIELD_HOME": home})
	env.Executable = func() (string, error) { return filepath.Join(src, BinaryNames()[0]), nil }
	if code := Run([]string{"self-install", "--json"}, env); code != ExitOK {
		t.Fatalf("exit %d: %s", code, out)
	}
	for _, n := range BinaryNames() {
		if got, _ := os.ReadFile(filepath.Join(home, "bin", n)); string(got) != n {
			t.Errorf("%s not installed", n)
		}
	}
	env, out, _ = testEnv(map[string]string{"TOKEN_SHIELD_HOME": home})
	if Run([]string{"self-install", "--json"}, env) != ExitError || !strings.Contains(out.String(), `"error"`) {
		t.Errorf("a missing executable should fail as JSON: %s", out)
	}
}

// TestLaunchers runs the real launchers against a freshly built binary.
func TestLaunchers(t *testing.T) {
	if testing.Short() {
		t.Skip("builds a binary")
	}
	dir := t.TempDir()
	plat := runtime.GOOS + "-" + runtime.GOARCH
	exe := "tshield"
	if runtime.GOOS == "windows" {
		exe += ".exe"
	}
	build := exec.Command("go", "build", "-o", filepath.Join(dir, plat, exe), "../../cmd/tshield")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build: %v\n%s", err, out)
	}
	for _, name := range []string{"tshield", "tshield.cmd"} {
		raw, err := os.ReadFile(filepath.Join("../../plugin/bin", name))
		if err != nil {
			t.Fatal(err)
		}
		_ = os.WriteFile(filepath.Join(dir, name), raw, 0o755)
	}
	if sh, err := exec.LookPath("sh"); err == nil {
		out, err := exec.Command(sh, filepath.Join(dir, "tshield"), "version").CombinedOutput()
		if err != nil || strings.TrimSpace(string(out)) != "dev" {
			t.Errorf("sh launcher: %q %v", out, err)
		}
	}
	if runtime.GOOS == "windows" {
		out, err := exec.Command("cmd", "/c", filepath.Join(dir, "tshield.cmd"), "version").CombinedOutput()
		if err != nil || strings.TrimSpace(string(out)) != "dev" {
			t.Errorf("cmd launcher: %q %v", out, err)
		}
	}
}
