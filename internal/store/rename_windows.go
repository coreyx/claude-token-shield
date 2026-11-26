//go:build windows

package store

import (
	"os"
	"path/filepath"
	"syscall"
	"unsafe"
)

var (
	kernel32                       = syscall.NewLazyDLL("kernel32.dll")
	procSetFileInformationByHandle = kernel32.NewProc("SetFileInformationByHandle")
)

const (
	// fileRenameInfoEx is FILE_INFO_BY_HANDLE_CLASS FileRenameInfoEx.
	fileRenameInfoEx = 22
	// Rename flags: replace the target, with POSIX semantics, so the replace
	// works even while readers that share delete still have the target open.
	renameReplaceIfExists = 0x1
	renamePOSIXSemantics  = 0x2
	accessDelete          = 0x00010000
)

// replace renames from over to with POSIX semantics (Windows 10 1709+ on
// NTFS). A plain MoveFileEx fails with "Access is denied" while any reader
// holds the target; this doesn't, as long as readers share delete
// (store.ReadFile does, and so does Node). On a file system without support
// it returns an error and the caller falls back to os.Rename.
func replace(from, to string) error {
	absTo, err := filepath.Abs(to)
	if err != nil {
		return err
	}
	src, err := syscall.UTF16PtrFromString(from)
	if err != nil {
		return err
	}
	h, err := syscall.CreateFile(src, accessDelete|syscall.SYNCHRONIZE,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
		nil, syscall.OPEN_EXISTING, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return &os.LinkError{Op: "rename", Old: from, New: to, Err: err}
	}
	defer syscall.CloseHandle(h)

	name, err := syscall.UTF16FromString(absTo)
	if err != nil {
		return err
	}
	name = name[:len(name)-1] // FileNameLength excludes the terminator.
	// FILE_RENAME_INFO: Flags (4 bytes, padded to the handle's alignment),
	// RootDirectory (a handle), FileNameLength (4 bytes), then the name.
	const handleSize = unsafe.Sizeof(syscall.Handle(0))
	nameOffset := handleSize + handleSize + 4
	buf := make([]byte, int(nameOffset)+len(name)*2+2)
	*(*uint32)(unsafe.Pointer(&buf[0])) = renameReplaceIfExists | renamePOSIXSemantics
	*(*uint32)(unsafe.Pointer(&buf[handleSize*2])) = uint32(len(name) * 2)
	for i, c := range name {
		*(*uint16)(unsafe.Pointer(&buf[int(nameOffset)+i*2])) = c
	}
	r, _, callErr := procSetFileInformationByHandle.Call(uintptr(h), fileRenameInfoEx, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	if r == 0 {
		return &os.LinkError{Op: "rename", Old: from, New: to, Err: callErr}
	}
	return nil
}
