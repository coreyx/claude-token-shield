---
status: approved
---

# Implementation Tasks: Token Shield

This document defines the implementation plan as a numbered checklist. Each task is linked to one or more acceptance criteria from [`requirements.md`](./requirements.md). The architecture, decisions (D1–D20) and interfaces the tasks build are in [`design.md`](./design.md). The stack and tools are in [`tech.md`](./tech.md).

Conventions for every task:

- Tests are written in the same task as the code they cover: Vitest for `plugin/core/`, `go test` for Go, `claude plugin test` for mod behavior.
- Logic that exists in both languages is added to `fixtures/parity/` in the same task that implements it. A task is not done until both suites pass.
- All fixtures are synthetic: real structure, every value replaced.

## Task List

### Milestone 1: Foundations confirmed

The repository builds and tests on three platforms, the shared data files exist, and the engine behaviors the design assumes are confirmed or replaced by their documented fallbacks.

- [x] **TASK-1: Create the repository skeleton**
  - **Associated Acceptance Criteria**: none (project setup)
  - **Concrete Steps**:
    1. Create `plugin/.claude-plugin/plugin.json` (name `token-shield`, version `0.1.0`, `types`, empty `userConfig`), `plugin/hooks/hooks.json`, a `plugin/hooks/register.tsx` that registers nothing yet, and `plugin/types/index.d.ts`.
    2. Create the root `package.json` (development dependencies only: TypeScript, Vitest, `@vitest/coverage-v8`), `tsconfig.json` extending the engine's generated config, and `vitest.config.ts` with coverage thresholds: critical modules (`assess`, `cost`, `gate`, `recommend`) 90% lines and branches, `core/` overall 80% lines and 70% branches.
    3. Create `go.mod` at the repo root, `embed.go` (package `shielddata`, embedding `plugin/data/*.json`), and empty `cmd/tshield`, `cmd/tshield-statusline` and `internal/` packages that build.
    4. Add `LICENSE` (MIT), a README stub, `.gitignore` (binaries, coverage, `node_modules`), and `.gitattributes` (LF for `bin/tshield`).
    5. Verify: `tsc -p plugin`, `claude plugin validate plugin`, `npx vitest run` and `go build ./...` all succeed.

- [x] **TASK-2: Confirm the engine assumptions with spikes**
  - **Associated Acceptance Criteria**: none (discovery; results decide which fallbacks in design.md "Assumptions to confirm early" apply)
  - **Concrete Steps**:
    1. Build a throwaway spike mod outside the repo, in the session's dev-mods folder, that exercises each of the six assumptions in design.md.
    2. Run each in a live session:
       - `classic.PreModelSwitch` and `classic.SessionStart` observed with `next(e)` returned, and Claude Code's confirmation still shown;
       - a toast or band visible while that confirmation is open;
       - `$.prompt.fill` after `{ drop }`;
       - `statusLine.refreshInterval` keeping the statusline running while idle (and its unit);
       - `$.process.run` inheriting `HOME`/`USERPROFILE` and `TOKEN_SHIELD_HOME`;
       - `/cache-check`-style display-only text answered mid-turn.
    3. Record each result, with the version tested and the fallback chosen if the assumption failed, in `spec/claude-token-shield/spikes.md`. Use structure only: no session content, paths or usernames.
    4. If a result needs a change beyond the design's documented fallback, stop and raise it before continuing.

- [x] **TASK-3: Add the shared data files and their loaders**
  - **Associated Acceptance Criteria**: `2.8`
  - **Concrete Steps**:
    1. Write `plugin/data/prices.json` (2026-11-03 table: per-model input price, read and 5m/1h write multipliers, tiers, and provider sections for Bedrock, Vertex and Foundry), `plugin/data/rules.json` (invalidation table, per-message-effort models, warn windows, timing constants, priors, display caps) and `plugin/data/strings.en.json` (every user-facing string by key).
    2. Write JSON Schemas for all three under `schemas/`, and validate the files against them in both test suites.
    3. Add a TypeScript loader (data injected into `core/`, read through `$.fs.read` in the mod) and a Go loader over the embedded files.
    4. Add a catalog test that fails if any string tagged `future` contains "hit" or "miss" as a word.

- [x] **TASK-4: Set up continuous integration on three platforms**
  - **Associated Acceptance Criteria**: `21.4`
  - **Concrete Steps**:
    1. Add `.github/workflows/ci.yml`: a matrix over `windows-latest`, `macos-latest` and `ubuntu-latest` running `tsc`, Vitest with coverage thresholds, `go vet`, `go test -cover ./...`, and the parity suite.
    2. Add a step that installs Claude Code and runs `claude plugin validate plugin` and `claude plugin test plugin`. If it can't run without sign-in, mark the step skipped with a comment, and add it to the release checklist (tech.md risk).
    3. Add a check that fails if any file under `plugin/hooks/` registers `prompt.compose`, `prompt.section`, `prompt.context`, `tool.describe`, `tool.list`, or returns `context`, `additionalContext` or `permissionDecision`.
    4. Verify the workflow passes on all three runners.

### Milestone 2: The decision engine works in TypeScript

`plugin/core/` assesses any fixture, prices it, quotes the levers, recommends one, decides the gate, and renders the check and the segment, all as pure, tested functions.

- [x] **TASK-5: Model facts, native snapshots and the session reducer**
  - **Associated Acceptance Criteria**: `1.1`, `1.3`, `1.7`
  - **Concrete Steps**:
    1. Define the `Fact` union, `NativeSnapshot`, `RequestRecord`, `EventRecord` and `SessionState` types with tier-tagged values (`measured`, `inferred`, `estimated`, `absent`).
    2. Implement `parseSnapshot`, which copies whitelisted documented fields only, records missing or malformed fields as `absent`, and never zero-fills.
    3. Implement `reduce(state, fact)`: last snapshot, a bounded main-lane request log (200), pending events since the last main request, and a TTL-change event when consecutive snapshots differ in `ttl`.
    4. Test with synthetic payload sequences, including one where `ttl` changes `1h → 5m` (exactly one event) and one with `expires_at` missing.

- [x] **TASK-6: Implement the assessor**
  - **Associated Acceptance Criteria**: `1.4`, `1.5`, `1.6`, `2.1`, `2.3`, `2.4`, `2.5`, `2.6`, `2.7`
  - **Concrete Steps**:
    1. Implement timing (native expiry first, `skew`, `t_err`, `margin`, `remaining`) and the drift event when native and own expiry disagree by more than the margin.
    2. Implement the six-state classifier in design D3's fixed precedence, driven by `rules.json`, with the version gate (< 2.1.260 → `UNKNOWN` naming v2.1.260).
    3. Implement `p_hit` (time component plus MAY events), the prior intervals, confidence levels, staleness (snapshot > 60 s → `LOW`), and the drivers list with tiers.
    4. Add the display-cap formatter (`≥ 99%`, `≤ 1%`, no percentage in `UNKNOWN`).
    5. Test one fixture per state (and that it yields no other state), the no-op events (MCP config edit, CLAUDE.md edit), a model switch, and effort changes on Sonnet 5 versus Opus 5.5 with subscription and API-key auth.

- [x] **TASK-7: Implement the cost model and billing modes**
  - **Associated Acceptance Criteria**: `3.1`, `3.2`, `3.3`, `3.4`, `3.5`
  - **Concrete Steps**:
    1. Implement `nextTurnCost` with tiered and per-provider prices from the table in effect at the request's date, warm, cold and penalty, excluding output, tool loops and subagents.
    2. Implement billing-mode detection (subscription, subscription-credits, api, provider) and unit labelling (API-equivalent, provider-priced, price-table date).
    3. Implement the merge of `prices.override.json` over the bundled table, and the preference for Claude Code's `estimated_cache_write_usd` when an action supplied one.
    4. Test the 812,470-token Opus 5.5 1h case (cold $6.50 ± $0.01, warm $0.16–$0.18), a subscription fixture with no unlabelled dollars, an override changing costs, and a `PreModelSwitch` estimate replacing the own figure. Nothing in `core/` can reach the network (it has no I/O).

- [x] **TASK-8: Implement the plan-share estimator**
  - **Associated Acceptance Criteria**: `3.2`
  - **Concrete Steps**:
    1. Implement `planShare` per design D5: group snapshots by 5-hour window, ratio of percent change to API-equivalent dollars per model family over 14 days, an interval from the per-window spread, and "learning" below 3 windows.
    2. Expose the share as `[estimated]` on the cost result for subscription modes.
    3. Test with synthetic window series, including integer-percentage steps and a window reset.

- [x] **TASK-9: Implement the lever catalog and the recommendation policy**
  - **Associated Acceptance Criteria**: `4.1`, `4.2`, `4.3`, `4.4`
  - **Concrete Steps**:
    1. Implement the lever descriptors in design D6 (continue, `/compact`, `/clear`, `/rewind`, `/recap`, `/btw`, keep-alive, probe, TTL settings, model/effort/fast choice), each with applicability, quote, effect on later turns, tier and a "when to use" string key.
    2. Implement `recommend` with the ordered policy, the 5-turn horizon for `COLD`/`INVALIDATED`, the exclusion of unknown costs, and `/clear` never recommended on cost alone.
    3. Test: an 812k `COLD` fixture lists continue, `/compact`, `/clear` and `/recap` with exactly one recommended; `HOT` gives "no action needed"; `/recap`'s text says it neither invalidates nor shrinks; an unknown-cost lever shows "cost unknown" and is never recommended.

- [x] **TASK-10: Implement the gate decision, notification policy and config validation**
  - **Associated Acceptance Criteria**: `9.1`, `9.2`, `9.4`, `12.1`, `12.2`, `12.4`, `12.5`, `22.1`, `22.2`
  - **Concrete Steps**:
    1. Implement `gateDecision` per design D9: hold, pass or warn from the assessment, the threshold (dollars or tokens, tokens only on subscription), the held-prompt hash and the 60-second window.
    2. Implement `notify` per design D13: transitions, levels, one per transition, at most one per 5 minutes except critical, and muted levels.
    3. Implement the config schema with defaults (D20) and validation that returns the default plus the name of each invalid key.
    4. Test: a `COLD` $6.50 fixture is held under default config; resubmission at 60 s passes and at 61 s is held; `UNKNOWN` is never held; a $5 threshold passes a $4 rebuild; `HOT → EXPIRING → COLD` gives two toasts; flapping gives at most one non-critical toast; muted warnings suppress `EXPIRING`.

- [x] **TASK-11: Build the check view model and the text renderers**
  - **Associated Acceptance Criteria**: `2.2`, `2.6`, `6.3`, `6.4`, `8.1`, `8.2`, `22.3`
  - **Concrete Steps**:
    1. Implement `checkView` for the default, verbose and diff modes, and publish `schemas/check.schema.json`.
    2. Implement `renderCheck` and `renderSegment` from the string catalog only, at a given width, with Unicode and ASCII glyph sets. Verbose output tags every figure with its tier.
    3. Write golden files under `fixtures/render/` for the segment in every state and for the check at 80 and 120 columns in both glyph sets.
    4. Test: `HOT` reads like `● cache HOT · 812k · warm until 16:40`; `COLD` includes the rebuild cost; ASCII gives `[cache HOT 812k ->16:40]`; `--diff` after a model switch names it; verbose includes the timeline and both expiry values.

### Milestone 3: The statusline bridge and `tshield check` work without the mod

The Go companions produce the same assessment, costs and text as the core, write native snapshots, and wrap the user's existing statusline.

- [x] **TASK-12: Port the core to Go with parity fixtures**
  - **Associated Acceptance Criteria**: `2.1`, `3.1`, `8.1`
  - **Concrete Steps**:
    1. Implement `internal/native`, `internal/assess`, `internal/cost`, `internal/levers` and `internal/render` against the embedded data files, mirroring the TypeScript functions.
    2. Write `fixtures/parity/*.json` cases (input snapshots, events, prices, time → expected `CheckView`, costs, exit code) covering every state, every billing mode and the recommendation cases from TASK-9.
    3. Add a parity runner to both suites, and make both pass the shared render goldens.

- [x] **TASK-13: Build the data-directory store, launchers and self-install**
  - **Associated Acceptance Criteria**: none (infrastructure for the bridge, the CLI and the mod's binary resolution)
  - **Concrete Steps**:
    1. Implement `internal/store`: data-directory resolution (`TOKEN_SHIELD_HOME`, else the user's home), atomic replace (temp file, then rename, retried on Windows sharing violations), JSONL append with size rotation, and the lock files.
    2. Implement `tshield paths --json`, `tshield version --json` and `tshield self-install` (copy both binaries to `<data>/bin/`, renaming the old ones aside first on Windows).
    3. Write the `bin/tshield` (POSIX sh) and `bin/tshield.cmd` launchers that pick `bin/<os>-<arch>/` binaries.
    4. Test atomic writes under concurrent readers, rotation, and self-install over a running binary on Windows.

- [x] **TASK-14: Build the `tshield-statusline` bridge**
  - **Associated Acceptance Criteria**: `8.3`, `18.1`, `18.2`, `21.1`
  - **Concrete Steps**:
    1. Read stdin (≤ 1 MiB), parse the documented fields, write `sessions/<id>/snapshot.json` atomically, and append to `snapshots.jsonl` only when a tracked field changed.
    2. Run the previous command from `bridge.json` through the platform shell with the same stdin and a 300 ms timeout, passing its output through byte for byte.
    3. Append the bridge's own segment when `mod-heartbeat.json` is absent or older than 90 s.
    4. Fail open: any error still runs the wrapped command and exits 0, logging to `logs/companions.log`.
    5. Test with a fixture wrapped command and with the mod heartbeat present and absent. Add `go test -bench` on a 1M-token-session payload, asserting p95 ≤ 50 ms excluding the wrapped command.

- [x] **TASK-15: Build `tshield check`**
  - **Associated Acceptance Criteria**: `7.4`, `19.1`, `19.2`
  - **Concrete Steps**:
    1. Implement `tshield check [--verbose|--diff] [--session <id>] [--json]`, assessing from the newest (or named) session's snapshot plus its history, and naming in verbose output the events only the mod sees.
    2. Map states to exit codes 0/10/20/30/40/50.
    3. Make `--probe` explain that an exact-prefix probe needs the mod, and make no request.
    4. Test: `--json` validates against `schemas/check.schema.json`; each state fixture exits with its code; `--probe` makes no network call.

- [x] **TASK-16: Build `tshield setup` for the bridge**
  - **Associated Acceptance Criteria**: `8.3`
  - **Concrete Steps**:
    1. Implement `tshield setup`: show the current and the new `statusLine` value, ask for confirmation, run `self-install`, save the previous command to `bridge.json`, and write `statusLine.command` and `refreshInterval` (as TASK-2 confirmed) into the user settings, aborting if the file changed since it was shown.
    2. Detect a managed setting that owns `statusLine` and report it without writing.
    3. Implement `tshield setup --undo`, which restores the saved command.
    4. Test setup and undo against fixture settings files, including an existing statusline command and a managed lock.

### Milestone 4: The mod shows the cache state in session

With the mod loaded, the status segment, band, toasts and `/cache-check` work from live engine events and the bridge snapshot, without writing anything to the conversation.

- [x] **TASK-17: Build the mod host: error boundary, configuration and binary resolution**
  - **Associated Acceptance Criteria**: `1.4`, `21.3`, `22.2`
  - **Concrete Steps**:
    1. Wrap every hook registration so an exception returns `next(e)` (or the default render) and logs once per error kind through `$.ui.log`.
    2. Declare the `userConfig` fields from design D20. Validate them on `session.start` and `config.set`, show one toast per invalid key, and mirror the effective config to `config.json`.
    3. Resolve the platform binary once per session through `$.process.run` and the data directory through `tshield paths --json`, falling back to `CLAUDE_PLUGIN_DATA` with bridge and CLI features marked unavailable. Run `self-install` when the installed version differs.
    4. Read the session version and disable cache features below 2.1.260 with a message naming that version.
    5. Write the `$.state` contract in `plugin/types/index.d.ts`. Test that a forced exception in the assessor leaves prompts submitting and writes one debug-log entry, and that an invalid threshold toasts its name and applies the default.

- [x] **TASK-18: Build the adapters and the history writer**
  - **Associated Acceptance Criteria**: `1.1`, `1.2`, `1.3`, `2.3`, `2.4`, `2.5`, `20.3`
  - **Concrete Steps**:
    1. Implement the snapshot reader (mtime poll every 5 s and on `turn.complete`), and the `turn.step` adapter (lane by `agentId`, usage, start time, model, effort, TTL).
    2. Implement the observe-only adapters for `command.run`, `config.set`, `session.compact`, `classic.PreModelSwitch`, `classic.PostModelSwitch`, `classic.PreCompact`, `classic.PostCompact` and `classic.SessionStart`, each turning the event into facts and returning `next(e)` untouched.
    3. Implement `SessionModel` in the mod (reducer plus cached assessment, recomputed on fact, timer or a render more than 1 s after the last).
    4. Implement the history writer: whitelisted records only, debounced whole-file chunk writes (close at 256 KiB or 500 records), and a heartbeat every 30 s.
    5. Test with `claude plugin test`: a sequence of steps and a snapshot produce the right state; MCP config and CLAUDE.md edits change nothing; a model switch gives `INVALIDATED`; written chunks contain none of the fixture's prompt or response strings.

- [x] **TASK-19: Show the status segment, band, toasts and timers**
  - **Associated Acceptance Criteria**: `8.1`, `8.2`, `9.1`, `9.2`, `9.3`, `9.4`, `9.5`, `22.3`
  - **Concrete Steps**:
    1. Call `$.ui.status(renderSegment(...))` after every assessment, honoring the glyph setting.
    2. Implement the `AbovePrompt` band (state mode for `EXPIRING`, `COLD` and `INVALIDATED`, hidden in `HOT`), labelled Token Shield, with the recommended lever.
    3. Route transitions through `notify` to `$.ui.toast`, each prefixed "Token Shield".
    4. Re-arm one `$.clock.after` at the next boundary after each assessment, and re-assess on a late tick (clock jumps).
    5. Test: the band is present in `COLD` and absent in `HOT`; an idle `EXPIRING` boundary toasts within 5 s with no input; the transition and mute cases from TASK-10 hold end to end.

- [ ] **TASK-20: Build the `/cache-check` command and the lever bar**
  - **Associated Acceptance Criteria**: `2.2`, `6.1`, `6.2`, `6.3`, `6.4`
  - **Concrete Steps**:
    1. Register `/cache-check` and parse its arguments (`--verbose`, `--diff`, `--probe`, `--force`, `history …`, `setup`, `keepalive …`, `ttl`, `forget`), dispatching subcommands built in later tasks.
    2. Answer `{ text, isTextDisplayOnly: true }` without calling `next(e)`. While a main turn runs, answer with empty text and open the pane instead (design D7).
    3. Place a display-only lever bar under the output with the applicable command levers.
    4. Add `/cache-check setup`, which calls the same setup flow as `tshield setup` through the confirm band.
    5. Test: the answer is display-only in both idle and mid-turn cases; the command makes no model call; verbose output carries tier tags, the timeline and both expiry values; `--diff` after a model switch names it.

### Milestone 5: The user can act on advice safely

Levers run with consent, prompts that would trigger an expensive rebuild are held, switches and resumes show their cost first, and the probe and keep-alive spend only what the user approved.

- [ ] **TASK-21: Build the lever runner, the compact and clear controls, and the settings writer**
  - **Associated Acceptance Criteria**: `5.1`, `5.2`, `5.3`, `5.4`, `17.1`, `17.2`, `17.3`, `17.4`
  - **Concrete Steps**:
    1. Implement `LeverRunner.run` for command levers through `$.command.run`, reporting a failure in a toast and changing nothing else.
    2. Implement `LeverButton`: compact runs at once; clear arms to an inverse, bold `CONFIRM?`, runs `/clear` on a second press within 3 s, and disarms on a `$.clock.after(3000)`. Arm state is per instance in `$.state`.
    3. Implement the band's confirm mode and `SettingsWriter`: show key, scope file and value; write on confirmation through `$.config.set` where a row exists, otherwise read-compare-write the user settings; show the JSON to paste if refused.
    4. Test: a compact press equals typing `/compact` with no confirmation; one clear press runs nothing, two within 3 s run `/clear`, and after 3 s the label resets and the next press arms again; a TTL lever leaves the settings file unchanged until confirmed; no control is offered for a subagent; a default-config session triggers no compaction, clear, rewind, settings change or API request by itself.

- [ ] **TASK-22: Build the submit gate**
  - **Associated Acceptance Criteria**: `12.1`, `12.2`, `12.3`, `12.4`, `12.5`, `21.2`
  - **Concrete Steps**:
    1. Implement the `prompt.submit` hook per design D9: pass commands, meta prompts and non-composer origins; read the cached assessment; hold with a Token Shield drop reason, without calling `$.prompt.fill` (Claude Code restores the dropped prompt itself; see spikes.md §3); pass the resubmitted identical prompt within 60 s.
    2. Keep the hash in memory only, and never touch `text` or `context`.
    3. Show the band with the recommended lever when holding, and a warning toast instead of holding when the gate is set to `warn`.
    4. Test: hold, release, 61-second re-hold, byte-identical release, `UNKNOWN` never held, and a fresh install holding in the `COLD` fixture. Add a timing harness asserting p95 hook overhead ≤ 20 ms.

- [ ] **TASK-23: Build the guard before invalidating actions**
  - **Associated Acceptance Criteria**: `10.1`, `10.2`, `10.3`, `10.4`, `10.5`, `10.6`
  - **Concrete Steps**:
    1. In `classic.PreModelSwitch`, while warm, show a Token Shield toast (held 30 s) and the band in guard mode with Claude Code's estimate and the cheaper alternative, then return `next(e)` unchanged. Act on one event per switch burst, the one whose `to_model` matches the request; stay silent when `to_model` equals `from_model`; clear the guard on `classic.PostModelSwitch`, the next submit, or an unchanged model in the snapshot (design D10, spikes.md §1–2).
    2. With `switchConfirm: on`, a warm event whose rebuild cost reaches the threshold returns `next(e)`'s result plus `permissionDecision: "ask"` and a Token Shield-labelled `permissionDecisionReason`; never `allow` or `deny`, and an existing `deny` beneath stands.
    3. On `/effort`, `/fast` or the matching `config.set` while warm, create the pending event and toast the cost when the rules say `WILL`.
    4. Treat `/reload-plugins` as a `MAY` event with an info toast.
    5. Stay silent when the cache is cold or invalidated.
    6. Test: a warm 812k switch shows Claude Code's unchanged confirmation path plus the labelled cost; a cold switch shows nothing; a paired event burst produces one toast; a same-model pick shows nothing; with `switchConfirm` on, a warm over-threshold switch returns `ask` with the labelled reason, and a cold or under-threshold one returns `next(e)` unchanged; with it off, no result carries a `permissionDecision`; effort on Opus 5.5 with a subscription shows nothing, and on Sonnet 5 shows the cost; every guard surface carries the Token Shield name.

- [ ] **TASK-24: Build resume guidance**
  - **Associated Acceptance Criteria**: `11.1`, `11.2`, `11.3`
  - **Concrete Steps**:
    1. On `classic.SessionStart` with `source` `resume` or `fork` and `prompt_cache_likely_expired`, show the band in resume mode before the first prompt: Claude Code's cold estimate and the four options (continue, `/compact`, `/clear` with a handoff, `/recap` first).
    2. Within the TTL, compute the expiry from `seconds_since_last_response` and the session's last recorded TTL (`[inferred]`), show "warm until HH:MM" in the segment, and show no band or warning.
    3. Test: a session last active 3 hours ago shows the cost and four options; one active 10 minutes ago on a 1h TTL shows "warm until HH:MM" and no warning; the first request after resume carries no Token Shield text.

- [ ] **TASK-25: Build the probe**
  - **Associated Acceptance Criteria**: `7.1`, `7.2`, `7.3`
  - **Concrete Steps**:
    1. Implement `/cache-check --probe [--force]` per design D12: refusal rules, quotes for both outcomes and the side effect, shown in the confirm band.
    2. On confirmation, call `$.model.fork({ prompt: "Reply with OK." })` with no effort. Classify the outcome from `cache_read_input_tokens`, report the measured usage, the actual cost and the new expiry, and record a probe record.
    3. Handle `nothing-to-fork` and API errors without changing state.
    4. Test: an `UNCERTAIN` fixture shows both costs and sends nothing before confirmation; a `COLD`/`HIGH` fixture is declined with a reason, and `--force` reaches confirmation; a fork result reading ≥ 95% of the prefix reports `HIT` and an expiry one TTL later.

- [ ] **TASK-26: Build the keep-alive**
  - **Associated Acceptance Criteria**: `15.1`, `15.2`
  - **Concrete Steps**:
    1. Implement `/cache-check keepalive until <time> max $<n>` and a band button, with the estimated total shown in confirm mode before it starts.
    2. Schedule refreshes at `expires_at − lead` (2 min on 1h, 30 s on 5m). Stop on any user prompt, when `spent + 1.2 × warm quote` would exceed the budget, at the end time, or after a refresh that misses.
    3. Show the spend so far in the band while it runs, and record each refresh.
    4. Test with simulated refresh costs that the budget is never exceeded, and that a prompt stops it before the next refresh.

### Milestone 6: History, calibration and advice are measurable

History, calibration, the advice report, the TTL advisor and the baseline work in the mod and in `tshield`, with identical numbers in both.

- [ ] **TASK-27: Build history summaries and the history views**
  - **Associated Acceptance Criteria**: `6.5`, `14.1`, `14.2`
  - **Concrete Steps**:
    1. Implement `summarize` in TypeScript and Go: per-turn rows, spend by cause (TTL expiry, model/effort/speed switch, tools, compaction, server-side per Claude Code, unexplained), avoidable spend (expiry re-caches with a return within 2× TTL, invalidating actions taken while warm), and the filters (`--session`, `--all`, `--since`, `--misses`).
    2. Add `/cache-check history` and `tshield history` with `--json`, reading chunks within the window and skipping unreadable or newer-schema chunks with a count in the footer.
    3. Add parity cases. Test that per-cause spend sums to the total, that a 70-minute gap on a 1h TTL is avoidable while a 3-hour gap is not, and that `--since 7d --misses` lists only misses from the last 7 days.

- [ ] **TASK-28: Build calibration and the drift alarm**
  - **Associated Acceptance Criteria**: `14.3`, `14.4`
  - **Concrete Steps**:
    1. Record the assessment that preceded each main request, and fill its actual outcome when the request lands.
    2. Implement `calibrate` in TypeScript and Go: buckets, Wilson intervals, reliability table, Brier score overall and per version × model × TTL, and drift detection with interval widening (design D19).
    3. Feed calibrated `ε` and intervals back into the assessor at session start (in the background, off the render path), and raise one critical toast per drift episode.
    4. Add `tshield calibration` and `history --calibration`. Test that table counts match the recorded predictions, and that a fixture with `HOT` misses above the interval raises exactly one alert.

- [ ] **TASK-29: Build recommendation records and the advice report**
  - **Associated Acceptance Criteria**: `4.5`, `14.5`
  - **Concrete Steps**:
    1. Persist every recommendation with all quotes, and record the lever taken per design D18 (first action within 10 minutes or before the next main request).
    2. Implement `evaluateAdvice` in TypeScript and Go with the 5-turn horizon and the 5% tolerance, and show the cheapest-in-hindsight share with `n` in the history views.
    3. Test with a fixture of recommendations and known outcomes.

- [ ] **TASK-30: Build the TTL advisor**
  - **Associated Acceptance Criteria**: `16.1`, `16.2`
  - **Concrete Steps**:
    1. Implement `adviseTtl` in TypeScript and Go: compare re-cache costs under 5m and 1h across the recorded idle-gap distribution, separately for the main conversation and subagents, and require at least 10 sessions with 20 idle gaps per bucket.
    2. Include the billing explanation (subscriptions use 1h within plan usage, 5m on usage credits).
    3. Add `/cache-check ttl` and `tshield ttl`, offering the TTL setting lever through TASK-21's settings writer.
    4. Test: a fixture with gaps mostly between 10 and 50 minutes on an API key recommends 1h with the estimated savings; a small fixture shows "not enough data".

- [ ] **TASK-31: Build backfill, the baseline, pruning and deletion**
  - **Associated Acceptance Criteria**: `14.6`, `20.3`
  - **Concrete Steps**:
    1. Implement `tshield backfill` per design D17: incremental per-file cursors, numbers-only extraction picked by key, `backfill/` chunks under a lock, and a coverage report for unparsable lines.
    2. Compute the pre-install baseline of avoidable spend per week, and show it beside the current figure in the history summary.
    3. Implement `tshield prune` and pruning on mod start (`historyDays`), plus `tshield forget` and `/cache-check forget` (with confirmation) deleting `history/`, `sessions/` and `backfill/`.
    4. Offer backfill once after setup, running only on the user's yes.
    5. Test with synthetic transcripts that no text field reaches a record, that the store sits under the data directory, and that forget leaves the history store empty.

### Milestone 7: The visualizers explain the cache

The Token Shield pane draws all five views from the same data as `/cache-check`, at 80 columns and in monochrome.

- [ ] **TASK-32: Build the pane shell and the prefix map**
  - **Associated Acceptance Criteria**: `13.1`, `13.4`
  - **Concrete Steps**:
    1. Register `/cache-view [map|runway|levers|context|history]`, open the `token-shield` pane, and draw a tab row with keyboard and press navigation.
    2. Build the shared text-bar primitives (patterned cells with glyph legends, width-adaptive layout down to 80 columns).
    3. Draw the prefix map: one bar per recent main request, split into layers, patterned by read, written and uncached, with rebuild rows labelled by cause.
    4. Test that a five-request fixture with one compaction shows five bars and labels the rebuild "compaction", at 80 and 120 columns.

- [ ] **TASK-33: Build the expiry runway and the context composition view**
  - **Associated Acceptance Criteria**: `13.2`, `13.4`
  - **Concrete Steps**:
    1. Draw the runway: time axis, `▲now`, warn window, expiry and margin, and the before and after costs. Refresh it on a `$.clock.every` while visible.
    2. Draw context composition from `$.session.usage({ breakdown: "summary" })`, marking each category stable or changing each turn.
    3. Test that an `EXPIRING` fixture places now inside the warn window and shows both costs.

- [ ] **TASK-34: Build the lever comparator**
  - **Associated Acceptance Criteria**: `4.1`, `13.3`, `17.5`
  - **Concrete Steps**:
    1. Draw the lever table (cost now, effect later, tier, recommended mark), with `LeverButton`s for the command levers and the compact and clear controls carrying their cost, effect and recommended mark.
    2. Route presses through `LeverRunner`, so a lever run here behaves exactly as from `/cache-check`'s lever bar.
    3. Test that the `COLD` 812k fixture shows the four levers with exactly one recommended, and that running `/compact` from the comparator equals running it from the lever bar.

- [ ] **TASK-35: Build the history dashboard**
  - **Associated Acceptance Criteria**: `13.4`, `13.5`
  - **Concrete Steps**:
    1. Draw re-cache spend by cause per day as stacked text bars, the idle-gap histogram against the TTL line, advice outcomes, the reliability table, and the TTL advisor section.
    2. Load history off the render path and show a loading state until it arrives.
    3. Test that the per-cause segments sum to the period's total re-cache spend.

### Milestone 8: Release-ready and verified

Privacy, performance and coverage are verified, the manual checks are done, and the plugin installs in one line.

- [ ] **TASK-36: Verify privacy and context hygiene**
  - **Associated Acceptance Criteria**: `1.2`, `5.4`, `6.1`, `20.1`, `20.2`, `20.3`
  - **Concrete Steps**:
    1. Add an automated test that runs a scripted fixture session through every surface and searches the whole data directory for the fixture's prompt, response and tool strings.
    2. Run a live scripted session twice, with Token Shield enabled and disabled, exercising every surface, with `switchConfirm` on. Compare total input tokens (equal apart from approved probe or keep-alive requests), and confirm the request after `/cache-check` carries none of its output.
    3. Monitor network connections during that session and confirm none come from Token Shield outside approved actions.
    4. Confirm `claude plugin validate` and the CI check show no forbidden hooks. Record results for the walkthrough.

- [ ] **TASK-37: Verify performance and fail-open behavior**
  - **Associated Acceptance Criteria**: `21.1`, `21.2`, `21.3`
  - **Concrete Steps**:
    1. Run the bridge benchmark and the gate timing harness on all three CI platforms, and record p95 figures.
    2. Inject a failure into each component (assessor, snapshot reader, history writer, renderer, bridge parse, wrapped command) and confirm prompts, commands and rendering continue with one debug-log entry.
    3. Fix any regression before proceeding.

- [ ] **TASK-38: Audit coverage and run the backtest**
  - **Associated Acceptance Criteria**: `21.4`
  - **Concrete Steps**:
    1. Check that the coverage thresholds pass: critical modules ≥ 90% lines and branches, `core/` ≥ 80% lines and 70% branches, Go ≥ 80% statements. Add tests where they fall short, or propose a justified lower target.
    2. Run the backtest over `fixtures/sessions/` and record reliability and Brier figures for the walkthrough.
    3. Confirm the full suite passes on Windows, macOS and Linux.

- [ ] **TASK-39: Package and publish the plugin**
  - **Associated Acceptance Criteria**: none (distribution, per tech.md "Distribution")
  - **Concrete Steps**:
    1. Add `.claude-plugin/marketplace.json` and `.github/workflows/release.yml`: cross-compile both binaries for six targets into `plugin/bin/<os>-<arch>/`, commit them to the release branch, and attach them to a GitHub Release.
    2. Verify that a marketplace entry can point at the release branch. If not, switch to the tech.md fallback (binaries from GitHub Releases plus a one-time setup step the mod explains).
    3. Write the README: install line, setup, commands, surfaces, privacy statement and uninstall (`tshield setup --undo`).
    4. Install from the marketplace on a clean machine on each platform and confirm the mod loads, `tshield` runs from the Bash tool, and setup wires the bridge.
    5. Before pushing or publishing, run the privacy scan of outgoing commits and text, and confirm the commit email is a GitHub noreply address.

- [ ] **TASK-40: Run the manual acceptance checks**
  - **Associated Acceptance Criteria**: `10.1`, `10.5`, `13.4`, `15.3`
  - **Concrete Steps**:
    1. Capture `/model` with a warm cache showing Claude Code's unchanged confirmation and Token Shield's labelled cost. Repeat with `switchConfirm: on`, through both `/model <name>` and the picker, showing the cost inside Claude Code's confirmation.
    2. Capture every pane view and `/cache-check` at 80 columns with color disabled, and review them for legibility.
    3. Run a keep-alive across a 90-minute idle period on a 1h TTL and confirm the next prompt reads the cache.
    4. Redact any private details from the captures, and record exact steps and results for the walkthrough.
