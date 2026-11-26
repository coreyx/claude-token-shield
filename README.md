# Token Shield

Prompt-cache awareness for long Claude Code sessions.

In sessions of 100k to 1M+ tokens, the expensive moments are prompt-cache rebuilds nobody saw coming: a model or effort switch, an expired cache, a resumed session. Token Shield reads Claude Code's own cache signals, tells you how warm your cache is and how sure it is, prices every lever you could pull right now (continue, `/compact`, `/clear`, `/rewind`, `/recap`, `/btw`, keep-alive), recommends one, and holds a prompt that would trigger an expensive rebuild until you confirm it. Nothing it shows is ever sent to the model.

> **Status:** under development. Not yet installable. Install instructions, commands and setup will be documented here when the first release ships.

## What's in this repository

| Path | What |
|---|---|
| `plugin/` | The Claude Code plugin: the mod (`hooks/`), its decision core (`core/`), and shared data (`data/`) |
| `cmd/`, `internal/` | Go companions: `tshield-statusline` (statusline bridge) and `tshield` (command-line tool) |
| `tests/` | Vitest tests for the TypeScript core |
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
```

## License

MIT. See [LICENSE](LICENSE).
