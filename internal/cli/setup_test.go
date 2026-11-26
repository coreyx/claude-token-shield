package cli

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// setupFixture lays out a home with a settings file and fake binaries next to "the running tshield".
func setupFixture(t *testing.T, settings string) (home, claude, src string) {
	t.Helper()
	home, claude, src = t.TempDir(), t.TempDir(), t.TempDir()
	if settings != "" {
		if err := os.WriteFile(filepath.Join(claude, "settings.json"), []byte(settings), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, n := range BinaryNames() {
		_ = os.WriteFile(filepath.Join(src, n), []byte(n), 0o755)
	}
	return home, claude, src
}

// setupEnv runs setup against the fixture with answer on stdin.
func setupEnv(t *testing.T, home, claude, src, answer string) Env {
	env, _, _ := testEnv(map[string]string{"TOKEN_SHIELD_HOME": home, "CLAUDE_CONFIG_DIR": claude})
	env.Stdin = strings.NewReader(answer)
	env.Executable = func() (string, error) { return filepath.Join(src, BinaryNames()[0]), nil }
	env.ManagedSettings = []string{filepath.Join(t.TempDir(), "managed-settings.json")}
	return env
}

const existing = `{
  "model": "opus",
  "statusLine": { "type": "command", "command": "my-status.sh", "padding": 1 },
  "permissions": { "allow": ["Bash(npm test)"] }
}
`

// TestSetupWrapsExistingStatusline keeps the user's command and settings (AC 8.3).
func TestSetupWrapsExistingStatusline(t *testing.T) {
	home, claude, src := setupFixture(t, existing)
	env := setupEnv(t, home, claude, src, "y\n")
	if code := Run([]string{"setup"}, env); code != ExitOK {
		t.Fatalf("exit %d", code)
	}
	raw, _ := os.ReadFile(filepath.Join(claude, "settings.json"))
	text := string(raw)
	if strings.Index(text, `"model"`) > strings.Index(text, `"statusLine"`) || strings.Index(text, `"statusLine"`) > strings.Index(text, `"permissions"`) {
		t.Errorf("key order changed:\n%s", text)
	}
	var s struct {
		StatusLine struct {
			Type            string `json:"type"`
			Command         string `json:"command"`
			Padding         int    `json:"padding"`
			RefreshInterval int    `json:"refreshInterval"`
		} `json:"statusLine"`
		Permissions map[string][]string `json:"permissions"`
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s.StatusLine.Command, "tshield-statusline") || s.StatusLine.Padding != 1 || s.StatusLine.RefreshInterval != RefreshIntervalSec || s.Permissions["allow"][0] != "Bash(npm test)" {
		t.Errorf("settings: %+v", s)
	}
	b, err := readBridgeFile(filepath.Join(home, "bridge.json"))
	if err != nil || b.PreviousCommand != "my-status.sh" {
		t.Errorf("bridge.json: %+v %v", b, err)
	}
	for _, n := range BinaryNames() {
		if _, err := os.Stat(filepath.Join(home, "bin", n)); err != nil {
			t.Errorf("%s not installed", n)
		}
	}

	// Running setup again keeps the original previous command.
	env = setupEnv(t, home, claude, src, "")
	if Run([]string{"setup", "--yes"}, env) != ExitOK {
		t.Fatal("second setup")
	}
	if b, _ := readBridgeFile(filepath.Join(home, "bridge.json")); b.PreviousCommand != "my-status.sh" {
		t.Errorf("re-setup lost the previous command: %+v", b)
	}

	// Undo restores the original statusLine exactly.
	env = setupEnv(t, home, claude, src, "y\n")
	if Run([]string{"setup", "--undo"}, env) != ExitOK {
		t.Fatal("undo")
	}
	raw, _ = os.ReadFile(filepath.Join(claude, "settings.json"))
	var after map[string]json.RawMessage
	_ = json.Unmarshal(raw, &after)
	var sl map[string]any
	_ = json.Unmarshal(after["statusLine"], &sl)
	if sl["command"] != "my-status.sh" || sl["padding"] != 1.0 || sl["refreshInterval"] != nil {
		t.Errorf("undo: %s", raw)
	}
	if _, err := os.Stat(filepath.Join(home, "bridge.json")); !os.IsNotExist(err) {
		t.Error("undo should remove bridge.json")
	}
	env = setupEnv(t, home, claude, src, "")
	if Run([]string{"setup", "--undo", "--yes"}, env) != ExitOK {
		t.Error("undo with nothing set up is a no-op")
	}
}

// TestSetupWithoutSettingsFile creates the file and undo removes the key.
func TestSetupWithoutSettingsFile(t *testing.T) {
	home, claude, src := setupFixture(t, "")
	env := setupEnv(t, home, claude, src, "")
	if Run([]string{"setup", "--yes"}, env) != ExitOK {
		t.Fatal("setup")
	}
	env = setupEnv(t, home, claude, src, "")
	if Run([]string{"setup", "--undo", "--yes"}, env) != ExitOK {
		t.Fatal("undo")
	}
	raw, _ := os.ReadFile(filepath.Join(claude, "settings.json"))
	if strings.TrimSpace(string(raw)) != "{}" {
		t.Errorf("undo should leave no statusLine: %s", raw)
	}
}

// TestSetupRespectsManagedSettings reports a managed statusLine and writes nothing.
func TestSetupRespectsManagedSettings(t *testing.T) {
	home, claude, src := setupFixture(t, existing)
	env := setupEnv(t, home, claude, src, "y\n")
	managed := filepath.Join(t.TempDir(), "managed-settings.json")
	_ = os.WriteFile(managed, []byte(`{"statusLine":{"type":"command","command":"corp-status"}}`), 0o644)
	env.ManagedSettings = []string{managed}
	if code := Run([]string{"setup"}, env); code != ExitError {
		t.Errorf("exit %d", code)
	}
	raw, _ := os.ReadFile(filepath.Join(claude, "settings.json"))
	if string(raw) != existing {
		t.Error("settings were changed despite the managed lock")
	}
}

// TestSetupDeclinedOrRaced writes nothing when declined or when the file changed meanwhile.
func TestSetupDeclinedOrRaced(t *testing.T) {
	home, claude, src := setupFixture(t, existing)
	env := setupEnv(t, home, claude, src, "n\n")
	if Run([]string{"setup"}, env) != ExitOK {
		t.Error("declining is not an error")
	}
	env.Stdin = racingReader{path: filepath.Join(claude, "settings.json")}
	if Run([]string{"setup"}, env) != ExitError {
		t.Error("a file changed during confirmation should abort")
	}
	raw, _ := os.ReadFile(filepath.Join(claude, "settings.json"))
	if strings.Contains(string(raw), "tshield-statusline") {
		t.Error("nothing should have been written")
	}
	env = setupEnv(t, home, claude, src, "")
	if Run([]string{"setup", "--bogus"}, env) != ExitUsage {
		t.Error("unknown option")
	}
	_ = os.WriteFile(filepath.Join(claude, "settings.json"), []byte("[1]"), 0o644)
	env = setupEnv(t, home, claude, src, "")
	if Run([]string{"setup", "--yes"}, env) != ExitError {
		t.Error("a settings file that isn't an object should fail")
	}
}

// racingReader answers yes after another program edits the settings file.
type racingReader struct{ path string }

func (r racingReader) Read(p []byte) (int, error) {
	_ = os.WriteFile(r.path, []byte(`{"model":"sonnet"}`), 0o644)
	return copy(p, "y\n"), nil
}
