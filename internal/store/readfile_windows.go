//go:build windows

package store

import (
	"io"
	"os"
	"syscall"
)

// ReadFile reads a whole file while letting a writer rename a new version
// over it. Go's os.Open omits FILE_SHARE_DELETE, so a reader holding
// snapshot.json would make the bridge's atomic replace fail with "Access is
// denied"; this opens with all three share modes, as Node does.
func ReadFile(path string) ([]byte, error) {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	h, err := syscall.CreateFile(p, syscall.GENERIC_READ,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
		nil, syscall.OPEN_EXISTING, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	f := os.NewFile(uintptr(h), path)
	defer f.Close()
	return io.ReadAll(f)
}
