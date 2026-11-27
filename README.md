# Token Shield

Prompt-cache awareness for long Claude Code sessions.

In sessions of 100k to 1M+ tokens, the expensive moments are prompt-cache rebuilds nobody saw coming: a model or effort switch, an expired cache, a resumed session. Token Shield reads Claude Code's own cache signals, tells you how warm your cache is and how sure it is, prices every lever you could pull right now (continue, `/compact`, `/clear`, `/rewind`, `/recap`, `/btw`, keep-alive), recommends one, and holds a prompt that would trigger an expensive rebuild until you confirm it. Nothing it shows is ever sent to the model.

> **Status:** the first release is in preparation. The install line below works once it's published.

## Install

Requires Claude Code v2.1.260 or later, in a terminal session. At the Claude Code prompt:

```
/plugin install token-shield --marketplace coreyx/claude-token-shield
```

Answer `y` to add the marketplace, then pick a scope (user is the usual choice). From a shell instead:

```sh
claude plugin install token-shield --marketplace coreyx/claude-token-shield
```

The plugin brings its two small companion programs for Linux, macOS and Windows (x64 and Arm), so there is nothing else to download.

## Set up

Run this once:

```
/cache-check setup
```

Token Shield shows what it will change, and nothing changes until you press **Confirm**. Setup copies the companions to `~/.token-shield/bin/` and points Claude Code's status line at the bridge, which records Claude Code's cache signals for Token Shield and still runs any status line you already had. Restart Claude Code afterwards. Without setup Token Shield still works, with less certainty about the cache.

Settings are in `/config` under Token Shield: the rebuild thresholds, the submit gate (`hold`, `warn` or `off`), expiry warnings, `switchConfirm`, keep-alive defaults, glyphs (`ascii` for terminals that can't draw the symbols) and how many days of history to keep.

## Commands

| Command | What it does |
|---|---|
| `/cache-check` | The cache's state, its expiry, the confidence behind it, and the recommended lever with every alternative priced |
| `/cache-check --verbose` | The same, with the evidence: each signal, its source, and the last request's measured usage |
| `/cache-check --diff` | What changed since the last request that read the cache |
| `/cache-check --probe` | Offers a one-line request to measure the cache directly, priced both ways, and sends it only on **Confirm** |
| `/cache-check keepalive for 90m max $1` | Offers to keep the cache warm with timed refreshes within a time limit and a budget; `/cache-check keepalive stop` ends it |
| `/cache-check ttl` | Whether the 5-minute or the 1-hour TTL would have cost you less, from your history; `/cache-check ttl 1h` offers to change the setting |
| `/cache-check history` | Re-cache spend by cause and what was avoidable; `--session`, `--all`, `--since 7d`, `--misses` and `--calibration` narrow or extend it |
| `/cache-check forget` | Offers to delete everything Token Shield has stored |
| `/cache-view map` | The cache prefix, layer by layer, and what each lever keeps or rebuilds |
| `/cache-view runway` | Time left before expiry, with the warning and refresh points |
| `/cache-view levers` | Every lever side by side, with buttons to act on them |
| `/cache-view context` | What fills the context window |
| `/cache-view history` | A dashboard of re-cache spend over time, by cause |

`/cache-check` output is drawn for you only: it never enters the conversation. The same reports are available from a shell as `tshield check`, `tshield history`, `tshield calibration` and `tshield ttl` (`tshield help` lists them all). The Bash tool finds `tshield` on its own; in your own shell it is `~/.token-shield/bin/tshield`.

## What you see while you work

- **Status line**: the cache's state and time left, alongside your own status line.
- **Band** above the prompt: a warning as expiry approaches, the cost of a pending action, and **Confirm** and **Cancel** buttons when Token Shield asks before acting.
- **Toasts** when something changes the cache's state, such as a model or effort switch or a resumed session.
- **Submit gate**: a prompt that would rebuild the cache above your threshold is held until you send it again (or only warned about, or neither, as you choose).
- **Model-switch guard**: the rebuild cost of a warm switch, shown as a toast or, with `switchConfirm` on, inside Claude Code's own confirmation.

On a subscription, costs are shown in tokens and API-equivalent dollars; the thresholds work in tokens.

## Privacy

- **Nothing leaves your machine.** Token Shield sends no data anywhere. The companions contain no networking code, which a test checks on every build.
- **No prompt text is kept.** History records numbers only: token counts, timestamps, model names and cache states. A test sweeps everything Token Shield writes, shows and logs for prompt, answer and tool text, and finds none.
- **Nothing reaches the model.** Token Shield's output is drawn for you and never added to the conversation, and it never changes what Claude Code sends.
- **Nothing is spent without you.** A probe or a keep-alive runs only after you confirm it, a keep-alive within the budget you set.

Data lives in `~/.token-shield/` (or `TOKEN_SHIELD_HOME`). History older than the configured number of days is removed automatically, and `/cache-check forget` removes all of it.

## Uninstall

Put your status line back first, then remove the plugin:

```sh
~/.token-shield/bin/tshield setup --undo
claude plugin uninstall token-shield@token-shield
```

On Windows the first line is `%USERPROFILE%\.token-shield\bin\tshield.exe setup --undo`. To delete the stored history as well, run `tshield forget --yes` before uninstalling, or remove `~/.token-shield/` afterwards.

## What's in this repository

| Path | What |
|---|---|
| `plugin/` | The Claude Code plugin: the mod (`hooks/`), its decision core (`core/`), and shared data (`data/`) |
| `cmd/`, `internal/` | Go companions: `tshield-statusline` (statusline bridge) and `tshield` (command-line tool) |
| `tests/` | Vitest tests for the TypeScript core |
| `scripts/` | Release build, synthetic backtest sessions, transcript totals for the live checks |
| `spec/claude-token-shield/` | Product definition, requirements, design and task list |

## Development

Requires Node.js (for the TypeScript tooling only), Go, and Claude Code v2.1.260 or later.

```sh
npm install          # development tooling only
npm test             # core unit tests
npm run coverage     # with coverage thresholds
go build ./...       # companions
go test ./...
claude plugin validate plugin
claude plugin test plugin
claude --plugin-dir plugin   # run it from the working tree
```

`node scripts/build-release.mjs <version>` stages the installable plugin with every target's binaries in `dist/plugin/`. A pushed `v<version>` tag runs the release workflow, which publishes that folder to the `release` branch the marketplace installs from and attaches the binaries to a GitHub Release.

## License

MIT. See [LICENSE](LICENSE).
