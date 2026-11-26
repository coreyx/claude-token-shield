# Shared data

JSON files read by both halves of Token Shield: the mod reads them at run time through `$.fs.read`, and the Go companions embed them at build time (`embed.go` at the repository root). Keeping one copy is what lets the TypeScript core and the Go port price and classify identically (design.md, D3 and D4).

- `prices.json`: the versioned price table.
- `rules.json`: the invalidation table, warn windows, timing constants, priors and display caps.
- `strings.en.json`: every user-facing string, by key.
