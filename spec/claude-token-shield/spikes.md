# Engine spikes

Results of TASK-2: the six engine behaviors listed under "Assumptions to confirm early" in [design.md](./design.md), exercised in a live session with a throwaway spike mod. The spike logged structure only (event and field names, booleans, numbers, model ids), never prompt text, paths or environment values.

- **Claude Code version tested:** 2.1.332 (Windows)
- **Spike session:** a fresh session with a small context (about 124k tokens, mostly the system prompt and tool definitions), the spike loaded with `--plugin-dir`, and a logging statusline loaded with `--settings`.

## Summary

| # | Assumption | Result | Decision |
|---|---|---|---|
| 1 | `classic.PreModelSwitch` / `classic.SessionStart` observed, `next(e)` leaves Claude Code's confirmation intact | **Holds**, with one quirk (paired events) | Design as written; pick one event per switch (below) |
| 2 | A toast or band is visible while the model-switch confirmation is open | **Holds for the toast only**: the confirmation covers the band and the status row | Guard warns with a toast held for the decision (`timeoutMs`); the band and status follow once the dialog closes, as the fallback says |
| 3 | `$.prompt.fill` after `{ drop }` puts the text back for a plain Enter | **Not needed**: the engine restores a dropped prompt itself, and a refill doubles it | Gate drops without refilling; the 60 s identical-resubmit rule is unchanged |
| 4 | `statusLine.refreshInterval` keeps the bridge running while idle | **Holds**; the unit is seconds | Setup sets `refreshInterval` in seconds |
| 5 | `$.process.run` children inherit the user's environment | **Holds** | Design as written; on Windows `HOME` is unset, so home comes from `USERPROFILE` |
| 6 | A plugin's display-only command text stays out of requests, including mid-turn | **Holds** | Design D7 as written |

No result needs a change beyond the design's documented fallbacks. One optional change is proposed at the end.

## 1. Classic events

- `classic.SessionStart` fires at startup (`source: startup`) and on resume (`source: resume`). On resume it carries `seconds_since_last_response`, `context_tokens`, `prompt_cache_likely_expired` and `estimated_cache_write_usd`; at startup those fields are absent.
- `classic.PreModelSwitch` carries every field the design reads: `source`, `from_model`, `to_model`, `requested_model`, `context_tokens`, `prompt_cache_warm`, `cache_ttl`, `estimated_cache_write_usd`, `pricing`. A hook returning `next(e)` unchanged got an empty result back and Claude Code's own flow ran untouched. `classic.PostModelSwitch` fires when the switch completes, and not when it is cancelled.
- **Paired events.** Each switch fires `PreModelSwitch` twice within a few milliseconds, with the same `requested_model` but different `to_model` values: for `/model haiku` from Opus, one event targets Haiku (the confirmation's only choice) and a second targets Sonnet, which the confirmation never offers. The model picker fires its pair when it opens, before anything is chosen.
  - *Decision:* within one burst, the guard shows the event whose `to_model` matches what was requested (the first of the pair in every run), and logs the other without showing it. TASK-23 confirms the rule against the picker, where `requested_model` is known only after the pick.
- **Same-model picks.** Choosing the model already in use switched immediately with no confirmation, after a `PreModelSwitch` reporting a warm cache. The guard must stay silent when `to_model` equals `from_model`; TASK-23 adds a test for it.

## 2. Visibility during the confirmation

- Claude Code's switch confirmation (both the typed `/model <name>` form and the picker) takes over the area around the input, hiding the above-prompt band and the status row until it closes.
- Toasts render at the top of the terminal, centered, and stay visible while the confirmation is open. The default toast lasts 4 s, short enough to miss; `$.ui.toast(text, { timeoutMs: 30000 })` stayed up for the whole decision, and hovering holds a toast.
- After the dialog closes, the band and status entry reappear. The spike never cleared them, so they lingered; the real guard clears its band mode and status suffix on `classic.PostModelSwitch`, on the next prompt submit, or when the snapshot shows the switch did not happen.
- *Decision:* the guard's in-time warning is a toast with a long `timeoutMs`, labelled Token Shield; the band in guard mode follows once the dialog closes. This is the documented fallback's second half (band right after the dialog closes) plus the toast the design already uses. The status-segment suffix is not visible during the dialog, so it is not relied on for timing.

## 3. Held prompts

- Returning `{ drop: reason }` from `prompt.submit` shows the reason in the transcript, and Claude Code puts the dropped text back in the input box by itself.
- Calling `$.prompt.fill` with the same text as well left two copies in the box; the next Enter sent the doubled text, which no longer matched the held prompt, so it was held and doubled again.
- Without the refill, the text came back once, and a second Enter within 60 s passed the identical-resubmit check and was sent.
- *Decision:* the gate does not call `$.prompt.fill`. This is a correction to the step in design D9 that refills the box; its intent (the prompt is back for a plain Enter) is met by the engine.

## 4. Statusline refresh

- With `refreshInterval: 10`, the statusline command ran every 10 s while the session sat idle, for up to 24 consecutive runs (4 minutes) without any input. The unit is seconds.
- The native `prompt_cache` object was present on every run after the session's first response, and absent before the first response and immediately after resume, before a new response. Its fields: `cache_write_tokens`, `caching_observed`, `expected_rebuilds`, `expires_at`, `hit_ratio`, `last_miss_at`, `last_miss_cause`, `miss_causes`, `miss_recache_tokens`, `misses`, `recache_tokens_if_cold`, `requests`, `ttl`, `warm`.
- *Decision:* setup sets `refreshInterval` in seconds. A missing `prompt_cache` before the first response is the design's existing "no response yet" case.

## 5. Child process environment

- A `node` child started with `$.process.run` saw `USERPROFILE` and a `TOKEN_SHIELD_HOME` set in the launching shell. `HOME` was unset, as is normal on Windows.
- `$.process.hookEnv()` returned `CLAUDECODE`, `CLAUDE_CODE_CHILD_NOTES_DIR`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_CODE_SESSION_ATTENDED`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`, `CLAUDE_PLUGIN_DATA`, `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PROJECT_DIR`.
- *Decision:* design as written. `tshield paths` resolves home from `TOKEN_SHIELD_HOME`, then `USERPROFILE` on Windows or `HOME` elsewhere, then the OS lookup.

## 6. Display-only command output

- A registered command answering `{ text, isTextDisplayOnly: true }` drew its text in the transcript. Asked afterwards, the model reported seeing the command invocations but none of their output.
- A command typed while a turn was running was queued by Claude Code and ran after the turn ended; its display-only text also stayed out of the model's context.
- *Decision:* design D7 as written. Because mid-turn commands are queued, `/cache-check` typed during a turn answers when the turn ends; D7's pane path for a mid-turn answer stays as a safeguard.

## Other findings

- **Validator rule for `$`.** `claude plugin validate` refuses a module that passes `$` to anything other than a function declared at the top level of a file (a function declaration, or a `const` bound to one) or one imported from another file. The mod's helpers that take `$` (adapters, actions, persistence) are therefore top-level functions in their own modules, never closures inside `register`.
- **Hot reload resets module state.** Module variables start over on each reload; anything that must survive one lives in `$.state` or `$.store`.

## Proposed change (not adopted)

The engine lets a `classic.PreModelSwitch` hook answer `permissionDecision: "ask"` with a `permissionDecisionReason`. Claude Code then shows its confirmation with the reason inside it:

> Switch model?
> A PreModelSwitch hook asked you to confirm
>
> Token Shield spike: this switch rebuilds the cache, ~$0.12

That puts the rebuild cost in front of the user at the moment of decision, including on the picker path, which otherwise has no confirmation. It conflicts with REQ-10.0.3 (Claude Code's confirmation is kept unchanged), so it would need a requirements change, for example as an opt-in guard mode. It is recorded here for a decision; the approved design is unaffected.
