// Package shielddata exposes the plugin's shared data files to the Go
// companions.
//
// It sits at the repository root because go:embed cannot reach a parent
// folder, and the single copy of the data must live inside plugin/ where the
// mod reads it at run time (design.md, "Repository layout").
package shielddata

import "embed"

// Files holds plugin/data as shipped with the plugin: prices, rules and the
// user-facing string catalog.
//
//go:embed plugin/data
var Files embed.FS
