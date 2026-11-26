# Shared data

JSON files read by both halves of Token Shield: the mod reads them at run time through `$.fs.read`, and the Go companions embed them at build time (`embed.go` at the repository root). Keeping one copy is what lets the TypeScript core and the Go port price and classify identically (design.md, D3 and D4).

- `prices.json`: price tables kept by effective date, in USD per million tokens: each model's base input price, cache read and 5-minute and 1-hour write multipliers, prompt-size tiers, the fast-mode price, and how each provider relates to list price.
- `rules.json`: the invalidation table (event kind → `WILL`, `MAY` or `NO_EFFECT`, with the cases that change it), the models that keep the cache across effort changes, warn windows, timing constants, priors and display caps.
- `strings.en.json`: every user-facing string, by key, with `{placeholders}`. Each string is tagged `future`, `past` or `none`; a `future` string never says "hit" or "miss" (AC 2.8).

Each file has a JSON Schema under `schemas/` at the repository root, and both test suites validate the files against it. Change a file and its schema together, and bump `v` only for a change older code can't read.
