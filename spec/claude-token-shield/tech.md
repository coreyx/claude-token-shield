---
status: approved
---

# Token Shield Tech Stack

## Summary

A Claude Code mod written in TypeScript against the engine's hooks-module API (`register.tsx`). Its decision logic lives in a pure TypeScript core with no engine dependencies. Companion Go binaries, stdlib only, provide the statusline bridge and the `tshield` CLI. The TypeScript core and Go agree on results through shared JSON test cases ("parity fixtures"). Mod and companions share a local data directory of plain JSON files. Tests use the engine's own kit (`claude plugin test`) for hooks and UI, Vitest with V8 coverage for the TypeScript core, and `go test` for the companions.

## Decisions

### Mod runtime and language

**Choice:** A Claude Code mod: `.claude-plugin/plugin.json` plus `hooks/hooks.json` naming one TypeScript hooks module, `hooks/register.tsx`, with JSX drawn through the engine's element tables (`$.ui.resolve`).

**Why:**
- This is the only surface that meets the core requirements:
  - a display-only slash command: `command.run` → `{ text, isTextDisplayOnly: true }` (REQ-6.0.5, REQ-20.0.1)
  - toasts, an above-prompt band and panes (REQ-9, REQ-13)
  - holding a prompt (`prompt.submit` drop, REQ-12)
  - timers (`$.clock`, REQ-9.0.5, REQ-15)
  - per-request usage with time and TTL (`turn.step`, REQ-1)
  - an exact-prefix probe (`$.model.fork`, REQ-7.0.2)
  - running commands (`$.command.run`, REQ-5.0.1, REQ-17)
  - drawing into the status line (`ui.render` on `StatusLine`, REQ-8)
- The author's `session-info` mod already proves this layout, its tests and its marketplace install path.

**Alternatives considered:**
- *Settings hooks plus scripts only*: they can't produce display-only command output, toasts or panes, and plain hook stdout is injected into context (REQ-20.0.1).
- *A local proxy*: excluded by REQ-5.0.4 (no request tampering).

### Shared decision logic (TypeScript core)

**Choice:** A `core/` folder inside the plugin: pure TypeScript with no engine globals, no Node APIs and no I/O. It holds the state classifier and assessor, the cost model, the lever catalog and ranking, calibration math, and history aggregation. The mod's hooks are thin adapters around it.

**Why:**
- REQ-2, 3, 4, 14 and 16 are pure computations over data. Keeping them pure makes them unit-testable outside the engine, at the coverage targets the full-tier testing standard sets.
- It also lets the same logic be checked against the Go companion's (see "Parity").
- It must sit inside the plugin folder, because only that folder is installed.

**Alternatives considered:** logic inline in the hooks, which would make it untestable without the engine and impossible to check for parity.

### Companion binaries (statusline bridge and `tshield`)

**Choice:** Go (current stable release), **standard library only**, one module with two commands: `tshield-statusline` and `tshield`. Cross-compiled for windows/amd64, windows/arm64, darwin/amd64, darwin/arm64, linux/amd64 and linux/arm64.

**Why:**
- REQ-21.0.1 sets a statusline p95 of 50 ms. A Go binary starts in milliseconds with no runtime to install, and Claude Code's native installer doesn't guarantee Node is present.
- The binaries are small enough (about 6 MB each) to ship inside the plugin.
- Stdlib only means no third-party license or maintenance risk.

**Alternatives considered:**
- *Bun-compiled binaries of the TypeScript core*: one language, but 60–100 MB per platform.
- *Scripts on the user's own Node or Bun*: a runtime requirement, and a slow start on Windows.

The author chose Go, accepting that the assessor and cost model exist in two languages.

### Parity between TypeScript and Go

**Choice:** A `fixtures/parity/` folder of JSON cases, each pairing an input (snapshots, events, a price table, the current time) with the expected assessment and costs. The Vitest suite and the `go test` suite both run every case.

**Why:** REQ-19.0.1 requires `tshield` and the in-session views to show the same content, and REQ-18.0.1 requires the statusline to render the same segment without the mod. A divergence fails both suites, not just one.

**Alternatives considered:** generating Go from TypeScript, or the reverse: brittle tooling for a small amount of logic.

### Native-signal bridge

**Choice:** `tshield-statusline` is configured as Claude Code's `statusLine.command`. On every run it:
1. reads the statusline JSON from stdin;
2. writes the `prompt_cache`, `context_window.current_usage`, `rate_limits`, `model`, `effort`, `fast_mode` and `version` fields to the data directory, as one file per session written atomically (temp file, then rename);
3. runs the user's previous statusline command, if any, passing the same stdin through, and prints its output unchanged;
4. when the mod isn't running for that session, appends the cache segment itself.

The mod reads that snapshot file. Without the bridge, the mod falls back to its own calculation from `turn.step` usage, labelled inferred.

**Why:**
- Native `prompt_cache` reaches only a statusline command; the mod API has no equivalent (REQ-1.0.1).
- Running the bridge also covers REQ-18 (segment without the mod, wrapping an existing command).
- Setup writes `statusLine.command` only after the user confirms (REQ-5.0.2).

**Alternatives considered:** the mod calculating on its own, without native miss causes or Claude Code's `warm` flag (rejected by the author).

### Data storage

**Choice:** Plain JSON files in `~/.token-shield/`, overridable with `TOKEN_SHIELD_HOME`:
- per-session snapshot files, written by the bridge;
- per-session, size-capped history chunk files, written by the mod through `$.fs.write`;
- the mod's effective configuration, mirrored for the CLI to read;
- the user's price overrides.

Each file has exactly one writer, so concurrent sessions never race. Pruning of old files is configurable (default 90 days). Session view state stays in `$.state`.

**Why:**
- REQ-20.0.2 wants data local and outside any project, and REQ-14.0.1 wants history across sessions.
- `$.store` caps out at 4 MiB in total, too small for weeks of history.
- `$.fs.write` replaces a whole file (there is no append), so small chunk files keep each write cheap.
- Both the mod and Go can read and write JSON with no dependencies.
- Deleting the folder satisfies REQ-14.0.9.

**Alternatives considered:**
- *SQLite*: no binding inside the mod engine, and cgo or a third-party driver on the Go side.
- *`$.store` only*: the size cap, and the CLI can't read it.

### Configuration

**Choice:** The plugin manifest's `userConfig` is the source of truth, edited in `/config` and validated by the engine. The mod writes the effective values to the data directory, and the companions read that copy. Price overrides are a separate JSON file in the data directory.

**Why:** REQ-22 settings get a native editing UX and engine validation (REQ-22.0.2) with no parser to maintain. The CLI only needs to read them.

**Alternatives considered:** a TOML file both sides parse, which means a hand-written parser in the mod and a third-party one in Go.

### Price table

**Choice:** One versioned `prices.json` inside the plugin, holding per-model base input, cache-read and 5-minute and 1-hour write rates, tier thresholds, a per-provider section and its effective date. The mod reads it with `$.fs.read`, and Go embeds it at build time (`go:embed`). User overrides merge on top.

**Why:** REQ-3.0.5 and 3.0.6 require a versioned, overridable, tiered, per-provider table. One file means both sides price identically, and the parity fixtures confirm it.

**Alternatives considered:** separate tables per language, which drift apart.

### Visualizers

**Choice:** Engine-native UI. Panes (`$.ui.open` with `ui.render` on `Pane`) for the prefix map, expiry runway, lever comparator, context composition and history dashboard; the `AbovePrompt` band; toasts; and the `StatusLine` site, all built from the engine's Box, Text and Button elements. Bars and histograms are drawn from text cells, with a glyph and a label, never color alone. Context composition comes from `$.session.usage({ breakdown: "summary" })`, the free local estimate.

**Why:** The engine has no DOM or charting library, and REQ-13.0.6 and 13.0.7 require views that work in monochrome and at 80 columns. `session-info` already draws meters and cards this way.

**Alternatives considered:** HTML reports outside the terminal, out of scope for a terminal-first release (`product.md` Non-goals).

### Distribution

**Choice:** A public GitHub repository with a root `.claude-plugin/marketplace.json`, installable with `/plugin install`. Source on `main`. A release workflow (GitHub Actions) cross-compiles the Go binaries into the plugin's `bin/` folder and publishes them on a release branch, which the marketplace entry points to, so one install brings everything. Binaries are also attached to each GitHub Release. MIT license.

**Why:**
- `product.md` sets one-line installation and the MIT license.
- Plugins can ship executables in `bin/`, which Claude Code also puts on the Bash tool's PATH (Claude Code plugins reference).
- Keeping binaries off `main` keeps its history small.

**Alternatives considered:** a hand-downloaded binary, which means extra setup friction for the bridge setup now on by default.

### Testing and quality tools

**Choice:**
- **Mod hooks and UI:** `claude plugin test` (engine kit, `*.test.ts`), plus `claude plugin validate`.
- **TypeScript core:** Vitest with `@vitest/coverage-v8` (MIT), a development dependency only, measuring line and branch coverage against the full-tier targets. Critical logic (assessor, cost model, gate decision) targets 90%+.
- **Companions:** `go test -cover`. Go reports statement coverage only, so the Go target is statement coverage, with branch behavior covered by the shared parity fixtures.
- **Type checking:** `tsc` against the engine's generated types.
- **Benchmarks:** for REQ-21.0.1 and 21.0.2, `go test -bench` for the bridge, plus a timing harness for the submit hook.

**Why:** `.claude/rules/testing-standards.md` requires measured coverage for full-tier work. The engine kit is the only way to exercise hooks and UI as the engine runs them.

**Alternatives considered:** `claude plugin test` alone, which has no coverage measurement.

### Continuous integration

**Choice:** GitHub Actions on Windows, macOS and Linux runners: Vitest with coverage, `go test` with coverage and the parity fixtures, `tsc`, and the cross-compile. `claude plugin validate` and `claude plugin test` run in CI if Claude Code can run unauthenticated there; otherwise locally before each release (see risks).

**Why:** REQ-21.0.5 and AC 21.4 require the suite to pass on all three platforms.

## Constraints & risks

- **Mod API stability.** The hooks-module API ships with the engine and has no published stability policy. Every engine update can break the mod. *Mitigation:* the logic lives in the pure core; adapters are thin; the minimum version is pinned (v2.1.260); CI runs against the latest engine.
- **Two implementations of the same logic.** The assessor and cost model exist in TypeScript and Go. *Mitigation:* the parity fixtures are required for every change to that logic, and Go carries only what the bridge and CLI need.
- **The bridge depends on the user's statusline setting.** Another tool or a managed setting can replace or lock `statusLine.command` (managed settings draw above the user's). *Mitigation:* the mod detects a missing bridge and falls back to its own inferred calculation, saying so in verbose output.
- **Marketplace branch support.** Pointing a marketplace entry at a release branch is assumed, not verified. *Fallback:* binaries in GitHub Releases, plus a one-time setup step the mod explains.
- **`claude plugin test` in CI.** Not confirmed to run without a signed-in Claude Code. *Fallback:* run it locally as a release checklist step.
- **Coverage gaps.** Go has no branch coverage, and the engine kit has no coverage measurement. Coverage targets are measured on the TypeScript core and the Go statement coverage; hook and UI glue is verified behaviorally.
- **Plan-share estimate (REQ-3.0.2).** It depends on how `rate_limits` percentages move between snapshots, which only the bridge sees. Without the bridge, plan share isn't shown.
- **Release-branch growth.** Committing binaries on each release grows that branch by about 36 MB per release. Squashing it later would rewrite published history, which needs the author's approval.
- **Licenses.** MIT (the project), BSD-3-Clause (Go standard library), MIT (Vitest and its coverage plugin, development only). No runtime third-party dependencies.

Sources: [Claude Code plugins reference](https://code.claude.com/docs/en/plugins-reference), [plugin components](https://code.claude.com/docs/en/plugins/components), [statusline](https://code.claude.com/docs/en/statusline), [prompt caching](https://code.claude.com/docs/en/prompt-caching); mod API types shipped with Claude Code 2.1.332.
