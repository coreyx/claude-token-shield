//go:build !windows

package store

import "os"

// replace renames from over to; outside Windows rename already replaces a
// file that readers have open.
func replace(from, to string) error { return os.Rename(from, to) }
