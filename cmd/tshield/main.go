// Command tshield is Token Shield's command-line tool: cache checks, history,
// calibration, setup and backfill from any terminal (requirements REQ-19).
// The commands themselves live in internal/cli.
package main

import (
	"os"

	"github.com/coreyx/claude-token-shield/internal/cli"
)

// main runs the command line and exits with its code.
func main() {
	os.Exit(cli.Run(os.Args[1:], cli.RealEnv()))
}
