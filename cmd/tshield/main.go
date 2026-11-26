// Command tshield is Token Shield's command-line tool: cache checks, history,
// calibration, setup and backfill from any terminal (requirements REQ-19).
//
// The skeleton only reports its version; later tasks add the subcommands.
package main

import (
	"fmt"
	"os"

	"github.com/coreyx/claude-token-shield/internal/version"
)

// main dispatches the subcommand named by the first argument.
func main() {
	if len(os.Args) > 1 && os.Args[1] == "version" {
		fmt.Println(version.Version)
		return
	}
	fmt.Fprintln(os.Stderr, "usage: tshield version")
	os.Exit(2)
}
