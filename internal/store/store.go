// Package store is the companions' access to the data directory (design.md
// "Data model"): where it is, writing files so readers never see half of one,
// appending JSONL with size rotation, and lock files for the few writers that
// must not overlap (setup and backfill).
package store

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// HomeEnv overrides the data directory's location.
const HomeEnv = "TOKEN_SHIELD_HOME"

// DirName is the data directory's name under the user's home.
const DirName = ".token-shield"

// DataDir returns the data directory: TOKEN_SHIELD_HOME when set, else
// ~/.token-shield. getenv is os.Getenv outside tests.
func DataDir(getenv func(string) string) (string, error) {
	if dir := strings.TrimSpace(getenv(HomeEnv)); dir != "" {
		return filepath.Clean(dir), nil
	}
	home := ""
	// os.UserHomeDir reads USERPROFILE on Windows and HOME elsewhere (spikes.md §5),
	// but through the real environment; honor the injected one first.
	if runtime.GOOS == "windows" {
		home = getenv("USERPROFILE")
	} else {
		home = getenv("HOME")
	}
	if home == "" {
		var err error
		if home, err = os.UserHomeDir(); err != nil {
			return "", fmt.Errorf("no home directory: set %s: %w", HomeEnv, err)
		}
	}
	return filepath.Join(home, DirName), nil
}

// renameRetries bounds retries when Windows refuses a rename because another
// process has the target open (a reader of snapshot.json, say).
const renameRetries = 30

// WriteAtomic replaces path with data: written to a temporary file in the same
// directory, synced, then renamed over the target, so a reader sees either
// the old content or the new, never a mix.
func WriteAtomic(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	_, werr := tmp.Write(data)
	serr := tmp.Sync()
	cerr := tmp.Close()
	if err := errors.Join(werr, serr, cerr); err != nil {
		_ = os.Remove(name)
		return err
	}
	if err := renameRetrying(name, path); err != nil {
		_ = os.Remove(name)
		return err
	}
	return nil
}

// renameRetrying renames from over to. It tries a POSIX-semantics replace
// first (see replace), then a plain rename, retrying briefly on the sharing
// violations Windows raises while a reader that doesn't share delete has the
// target open.
func renameRetrying(from, to string) error {
	var err error
	for i := 0; i < renameRetries; i++ {
		if err = replace(from, to); err == nil {
			return nil
		}
		if err = os.Rename(from, to); err == nil || runtime.GOOS != "windows" {
			return err
		}
		time.Sleep(time.Duration(i+1) * 2 * time.Millisecond)
	}
	return err
}

// AppendLine appends one line to a JSONL file. When the file would grow past
// maxBytes it is first rotated to path.1 (replacing an older rotation), so the
// file and its rotation together stay under twice the limit.
func AppendLine(path string, line []byte, maxBytes int64) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if fi, err := os.Stat(path); err == nil && fi.Size()+int64(len(line))+1 > maxBytes {
		if err := renameRetrying(path, path+".1"); err != nil {
			return err
		}
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	_, werr := f.Write(append(append([]byte{}, line...), '\n'))
	return errors.Join(werr, f.Close())
}

// ErrLocked means another process holds the lock.
var ErrLocked = errors.New("locked by another process")

// Lock is a held lock file.
type Lock struct{ path string }

// Acquire takes the lock at path, or fails with ErrLocked. A lock older than
// staleAfter is taken over: its holder died without releasing it.
func Acquire(path string, staleAfter time.Duration, now time.Time) (*Lock, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	for attempt := 0; attempt < 2; attempt++ {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			_, werr := fmt.Fprintf(f, "%d %d\n", os.Getpid(), now.UnixMilli())
			if err := errors.Join(werr, f.Close()); err != nil {
				_ = os.Remove(path)
				return nil, err
			}
			return &Lock{path: path}, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return nil, err
		}
		if !stale(path, staleAfter, now) {
			return nil, ErrLocked
		}
		_ = os.Remove(path)
	}
	return nil, ErrLocked
}

// stale reports whether a lock file is older than staleAfter.
func stale(path string, staleAfter time.Duration, now time.Time) bool {
	raw, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	fields := strings.Fields(string(raw))
	if len(fields) < 2 {
		return true
	}
	ms, err := strconv.ParseInt(fields[1], 10, 64)
	return err != nil || now.Sub(time.UnixMilli(ms)) > staleAfter
}

// Release removes the lock.
func (l *Lock) Release() error {
	if err := os.Remove(l.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// copyFile copies src to dst through a temporary file and a rename.
func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".new"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	_, cerr := io.Copy(out, in)
	if err := errors.Join(cerr, out.Close()); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return renameRetrying(tmp, dst)
}

// Install copies the named binaries from srcDir into destDir. A destination
// that exists is first renamed aside: Windows won't overwrite a running
// executable but will rename it, so a statusline mid-run doesn't block an
// update. Old copies are removed when no longer in use.
func Install(srcDir, destDir string, names []string, now time.Time) ([]string, error) {
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return nil, err
	}
	var installed []string
	for _, name := range names {
		src := filepath.Join(srcDir, name)
		if _, err := os.Stat(src); err != nil {
			return installed, fmt.Errorf("%s: %w", name, err)
		}
		dst := filepath.Join(destDir, name)
		if _, err := os.Stat(dst); err == nil {
			if err := renameRetrying(dst, fmt.Sprintf("%s.old-%d", dst, now.UnixNano())); err != nil {
				return installed, fmt.Errorf("moving the old %s aside: %w", name, err)
			}
		}
		if err := copyFile(src, dst, 0o755); err != nil {
			return installed, err
		}
		installed = append(installed, dst)
	}
	// Best effort: an old copy still running stays until a later install.
	old, _ := filepath.Glob(filepath.Join(destDir, "*.old-*"))
	for _, o := range old {
		_ = os.Remove(o)
	}
	return installed, nil
}
