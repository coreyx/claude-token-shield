# Live checks: Token Shield

The checks the automated suites can't make, for TASK-36 (steps 2–3) and TASK-40. Each needs a real Claude Code session, so run them yourself and fill in the results tables; the walkthrough records them.

**Related documents**
- [Tasks](./tasks.md)
- [Requirements](./requirements.md)

## Before you start

1. Build the companions for this machine from the repository root (the release workflow does this for every platform; locally it's two commands). Each `-o` must be paired with its own `./cmd/...` folder: pointing `go build -o` at any other package writes a library archive under the `.exe` name, which can't run.

   Windows:

   ```
   go build -o plugin/bin/windows-amd64/tshield.exe ./cmd/tshield
   go build -o plugin/bin/windows-amd64/tshield-statusline.exe ./cmd/tshield-statusline
   ```

   macOS (Apple silicon):

   ```
   go build -o plugin/bin/darwin-arm64/tshield ./cmd/tshield
   go build -o plugin/bin/darwin-arm64/tshield-statusline ./cmd/tshield-statusline
   ```

   Linux (x64):

   ```
   go build -o plugin/bin/linux-amd64/tshield ./cmd/tshield
   go build -o plugin/bin/linux-amd64/tshield-statusline ./cmd/tshield-statusline
   ```

   Then check the build answers, using the same folder: `plugin/bin/windows-amd64/tshield.exe version --json` (or `plugin/bin/<os>-<arch>/tshield version --json`) prints one line of JSON with `"os"` and `"arch"`. If it errors instead, rebuild before going on. Token Shield checks for the binary when a session starts, so a session that was already open when you rebuilt needs a restart.

2. Make a throwaway project folder with a small README in it, so the scripted session has something to read.
3. Start Claude Code there with the plugin loaded: `claude --plugin-dir <repo>/plugin`. Run `/cache-check setup` and press **Confirm**, then restart Claude Code so the statusline bridge is active.
4. In `/config`, set Token Shield's **Confirm costly model switches** to `on`.

## Check 1: the same session costs the same tokens with Token Shield on and off (AC 20.1)

Run this script twice in fresh sessions in the same folder: once with the plugin loaded, once without (`claude` with no `--plugin-dir`). Type the prompts exactly. Lines marked *(on only)* are Token Shield's commands; skip them in the run without it. Note which session id is which run as you go.

0. `/model opus`. Claude Code saves a `/model` choice as the default for later sessions, so step 5 of the first run would otherwise start the second run on Sonnet, and the runs wouldn't be comparable.
1. `Read README.md and summarize it in three lines.`
2. *(on only)* `/cache-check`, then `/cache-check --verbose`, then `/cache-view map` (close the pane), then `/cache-check history`.
3. `List two improvements to that README, one line each.`
4. *(on only)* `/cache-check --diff`.
5. `/model sonnet`. With the plugin loaded, Claude Code's confirmation should show a line starting **Token Shield:** with the rebuild cost; confirm the switch in both runs.
6. `Did any message above include output from a /cache-check or /cache-view command? Answer yes or no, then quote it if yes.`
7. `/exit`

Then total each run's input tokens from its transcript (under `~/.claude/projects/<project>/<session id>.jsonl`; the newest file in that project folder is the session you just ran):

```
node scripts/sum-transcript.mjs <transcript.jsonl> --per-request
```

It prints numbers only: one line per request with the model it went to, then the totals. Check that both runs' requests went to the same models in the same order (Opus, then Sonnet for the last). Don't run a probe or a keep-alive in either session: those are the approved requests the comparison may differ by.

| | Requests | Total input tokens | Model's answer to step 6 |
|---|---|---|---|
| Token Shield on | | | |
| Token Shield off | | | |

**Pass:** both runs' requests went to the same models in the same order. The on run's totals are larger only by Claude Code's note for each Token Shield command typed (about 40 tokens each, its name only, carried into every later request: AC 20.1) and by small differences in the model's own answers; compare the per-request figures to tell these apart. The answer to step 6 is "no".

## Check 2: no network traffic from Token Shield (AC 20.2)

While running the session with Token Shield on, watch for connections from its two binaries. Token Shield's mod makes no requests of its own, and the binaries contain no networking code (the `TestNoNetworkImports` test checks this on every build), so this confirms it at runtime.

| OS | Command (run repeatedly during the session) |
|---|---|
| Windows (PowerShell) | `Get-NetTCPConnection \| Where-Object OwningProcess -in (Get-Process tshield* -ErrorAction SilentlyContinue).Id` |
| macOS | `lsof -i -n -P \| grep tshield` |
| Linux | `ss -tpn \| grep tshield` |

| Result | |
|---|---|
| Connections seen from `tshield` or `tshield-statusline` | |

**Pass:** none. Claude Code's own connections are expected and aren't Token Shield's.

## Check 3: the model-switch guard on screen (AC 10.1, 10.5)

1. With a warm cache (send a prompt, then switch within a few minutes) and **Confirm costly model switches** set to `off`, run `/model sonnet`. Capture the screen while Claude Code's confirmation is open: its own confirmation unchanged, and the Token Shield toast with the rebuild cost at the top.
2. Set **Confirm costly model switches** to `on` and repeat with `/model sonnet`, and again through the model picker (`/model` with no argument). Capture each: the cost line starting **Token Shield:** inside Claude Code's confirmation.
3. Cancel one switch and confirm the other; the switch happens only on confirm.

| Capture | Done |
|---|---|
| Confirm costly model switches off, `/model sonnet` | |
| Confirm costly model switches on, `/model sonnet` | |
| Confirm costly model switches on, picker | |

## Check 4: every view at 80 columns without colour (AC 13.4)

Resize the terminal to 80 columns and turn colour off (`NO_COLOR=1` in the environment before starting Claude Code). Capture `/cache-check`, `/cache-check --verbose`, and each pane view: `/cache-view map`, `runway`, `levers`, `context` and `history`. Then set Token Shield's **Glyphs** to `ascii` and capture `/cache-check` once more.

**Pass:** every line fits, and every state and pattern reads from its glyph or label alone.

## Check 5: a keep-alive across a 90-minute idle (AC 15.3)

On a session using the 1-hour TTL (check `/cache-check` says **1 hour**), send a prompt, then run `/cache-check keepalive for 100m max $2` and press **Confirm**. Leave the session idle for 90 minutes. Then send a prompt and run `/cache-check --verbose`.

| Result | |
|---|---|
| Refreshes made and spend (from the keep-alive's stop toast) | |
| The next prompt's cache read (from `--verbose`: last request read) | |

**Pass:** the prompt after the idle reads the cache, and the spend stays within the budget.

## Before you share any capture

Crop or redact tab titles, usernames, file paths, notifications and anything else on screen that isn't Token Shield (see the privacy rules). Captures are for the walkthrough; attach them only once they're clean.
