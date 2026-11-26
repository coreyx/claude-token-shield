package store

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestDataDir honors TOKEN_SHIELD_HOME, then the platform's home variable.
func TestDataDir(t *testing.T) {
	env := map[string]string{HomeEnv: "  /tmp/example-shield  "}
	get := func(k string) string { return env[k] }
	if dir, _ := DataDir(get); dir != filepath.Clean("/tmp/example-shield") {
		t.Errorf("override: %s", dir)
	}
	delete(env, HomeEnv)
	env["HOME"], env["USERPROFILE"] = "/home/example", `C:\Users\example`
	want := filepath.Join("/home/example", DirName)
	if runtime.GOOS == "windows" {
		want = filepath.Join(`C:\Users\example`, DirName)
	}
	if dir, _ := DataDir(get); dir != want {
		t.Errorf("home: %s, want %s", dir, want)
	}
	// With nothing set, the OS lookup still finds a home.
	if dir, err := DataDir(func(string) string { return "" }); err != nil || !strings.HasSuffix(dir, DirName) {
		t.Errorf("fallback: %s %v", dir, err)
	}
}

// TestWriteAtomicUnderReaders never lets a reader see a mix of two versions.
func TestWriteAtomicUnderReaders(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sessions", "s1", "snapshot.json")
	a, b := bytes.Repeat([]byte("A"), 4096), bytes.Repeat([]byte("B"), 4096)
	if err := WriteAtomic(path, a); err != nil {
		t.Fatal(err)
	}
	stop := make(chan struct{})
	var wg sync.WaitGroup
	var mu sync.Mutex
	torn := 0
	for r := 0; r < 4; r++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
				}
				got, err := ReadFile(path)
				if err != nil {
					continue // Windows may refuse a read mid-rename; that is not a torn read.
				}
				if !bytes.Equal(got, a) && !bytes.Equal(got, b) {
					mu.Lock()
					torn++
					mu.Unlock()
				}
			}
		}()
	}
	for i := 0; i < 200; i++ {
		v := a
		if i%2 == 1 {
			v = b
		}
		if err := WriteAtomic(path, v); err != nil {
			t.Fatal(err)
		}
	}
	close(stop)
	wg.Wait()
	if torn > 0 {
		t.Errorf("%d reads saw a partial file", torn)
	}
	left, _ := filepath.Glob(filepath.Join(filepath.Dir(path), ".*tmp-*"))
	if len(left) > 0 {
		t.Errorf("temporary files left: %v", left)
	}
}

// TestAppendLineRotates keeps the file under its limit by rotating to .1.
func TestAppendLineRotates(t *testing.T) {
	path := filepath.Join(t.TempDir(), "snapshots.jsonl")
	for i := 0; i < 10; i++ {
		if err := AppendLine(path, []byte(`{"n":12345}`), 40); err != nil {
			t.Fatal(err)
		}
	}
	cur, _ := os.ReadFile(path)
	old, _ := os.ReadFile(path + ".1")
	if len(cur) > 40 || len(old) == 0 || !strings.HasSuffix(string(cur), "}\n") {
		t.Errorf("current %q, rotated %q", cur, old)
	}
}

// TestLock covers contention, release and stale takeover.
func TestLock(t *testing.T) {
	path := filepath.Join(t.TempDir(), "setup.lock")
	now := time.UnixMilli(1_000_000)
	l, err := Acquire(path, time.Minute, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Acquire(path, time.Minute, now.Add(time.Second)); !errors.Is(err, ErrLocked) {
		t.Errorf("second acquire: %v", err)
	}
	if _, err := Acquire(path, time.Minute, now.Add(2*time.Minute)); err != nil {
		t.Errorf("stale takeover: %v", err)
	}
	if err := l.Release(); err != nil {
		t.Error(err)
	}
	if err := l.Release(); err != nil {
		t.Errorf("double release: %v", err)
	}
	_ = os.WriteFile(path, []byte("garbage"), 0o644)
	if _, err := Acquire(path, time.Minute, now); err != nil {
		t.Errorf("malformed lock should be stale: %v", err)
	}
}

// TestHelperProcess is not a test: Install's test runs it as a long-lived binary.
func TestHelperProcess(t *testing.T) {
	if os.Getenv("TSHIELD_HELPER_SLEEP") != "1" {
		return
	}
	time.Sleep(5 * time.Second)
	os.Exit(0)
}

// TestInstallOverRunningBinary replaces a binary that is running, as setup
// does while a statusline is mid-run.
func TestInstallOverRunningBinary(t *testing.T) {
	src, dst := t.TempDir(), t.TempDir()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	name := "tshield-test-helper"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	exe, _ := os.ReadFile(self)
	// The running copy at the destination.
	if err := os.WriteFile(filepath.Join(dst, name), exe, 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(filepath.Join(dst, name), "-test.run=^TestHelperProcess$")
	cmd.Env = append(os.Environ(), "TSHIELD_HELPER_SLEEP=1")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	time.Sleep(200 * time.Millisecond)

	newContent := []byte("new binary")
	if err := os.WriteFile(filepath.Join(src, name), newContent, 0o755); err != nil {
		t.Fatal(err)
	}
	installed, err := Install(src, dst, []string{name}, time.Unix(1, 0))
	if err != nil {
		t.Fatalf("install over a running binary: %v", err)
	}
	got, _ := os.ReadFile(filepath.Join(dst, name))
	if len(installed) != 1 || !bytes.Equal(got, newContent) {
		t.Errorf("installed %v, content %q", installed, got)
	}
	if _, err := Install(src, dst, []string{"missing"}, time.Unix(2, 0)); err == nil {
		t.Error("a missing source binary should fail")
	}
}
