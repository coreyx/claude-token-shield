// Package version reports the version of the Token Shield companion
// binaries, so the mod can tell whether the copies it installed in the data
// directory match the plugin it shipped with (design.md, D14 and D15).
package version

// Version is the companions' release version. Release builds overwrite it
// with -ldflags "-X github.com/coreyx/claude-token-shield/internal/version.Version=<v>";
// a development build reports "dev".
var Version = "dev"
