//go:build !windows

package store

import "os"

// ReadFile reads a whole file. Outside Windows a rename over an open file is
// always allowed, so plain os.ReadFile already cooperates with WriteAtomic.
func ReadFile(path string) ([]byte, error) { return os.ReadFile(path) }
