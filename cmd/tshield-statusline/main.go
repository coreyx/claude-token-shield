// Command tshield-statusline is Token Shield's statusline bridge: configured as
// Claude Code's statusLine.command, it records the native prompt-cache data
// for the mod, runs the user's previous statusline command, and draws the
// segment itself when the mod is absent (design.md D14). It always exits 0.
package main

import (
	"os"

	"github.com/coreyx/claude-token-shield/internal/bridge"
)

// main runs one statusline invocation.
func main() {
	os.Exit(bridge.Run(bridge.RealEnv()))
}
