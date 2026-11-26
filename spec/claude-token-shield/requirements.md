---
status: approved
---

# Requirements Specification: Token Shield

## 1. Project Summary

This spec covers the first public release of Token Shield: a Claude Code mod, with a statusline script and a `tshield` command-line tool as companions. It does four things:

- Reads Claude Code's native prompt-cache signals and turns them into a trustworthy cache state.
- Prices every cache lever available at the moment and recommends one.
- Runs the chosen lever with the user's consent.
- Guards the moments where rebuilds happen (before invalidating actions, on resume, at submit), and visualizes cache behavior so users learn to manage it themselves.

It also takes over the `/COMPACT` and `/CLEAR` controls from the author's `session-info` mod.

What the product is, who it serves and why lives in `product.md`. The cache rules, certainty taxonomy, confidence algorithm and data sources these requirements build on come from the analysis design doc.

**Related documents**
- [Product](product.md)
- [Cache awareness design (analysis)](../../analysis/claude-token-shield/cache-awareness-design.md)
- [Seed: feature spec](../../analysis/claude-token-shield/cache-feature-spec.md)
- [Seed: /cache-check command](../../analysis/claude-token-shield/cache-check-command.md)
- [Seed: passive monitor](../../analysis/claude-token-shield/cache-monitor-design.md)
- [Seed: confidence engine](../../analysis/claude-token-shield/cache-confidence-engine.md)

### Terms used below

| Term | Meaning |
|---|---|
| **Native signals** | Data Claude Code itself provides: the statusline JSON (`prompt_cache`, `context_window.current_usage`, `cost`, `rate_limits`, `model`, `effort`, `fast_mode`, `version`), hook inputs (`SessionStart`, `PreModelSwitch`, `PreCompact`/`PostCompact`, `UserPromptSubmit`), and mod events and session data |
| **Lever** | An action that affects cache cost: continue, `/compact`, `/clear`, `/rewind`, `/recap`, `/btw`, keep-alive, a probe, TTL settings, or the choice of model, effort or fast mode |
| **Next-turn cost** | The input cost of the first API request of the user's next turn, the only request exposed to a cold cache |
| **Certainty tier** | `measured` (directly observed, always about the past), `inferred` (derived deterministically from measured facts and documented rules), or `estimated` (a calibrated probability about unobservable or future state) |
| **Threshold** | The user-configurable re-cache cost above which Token Shield warns or holds (default: $2 or 250,000 tokens, whichever is reached first) |
| **Context write** | Anything that enters a request to the model: a transcript message, injected hook context, or a command output that is sent to the model |

## 2. Requirements (EARS Format)

Requirements use the Easy Approach to Requirements Syntax (EARS):
- **Ubiquitous**: The system shall <response>.
- **Event-Driven**: When <trigger>, the system shall <response>.
- **State-Driven**: While <precondition>, the system shall <response>.
- **Unwanted Behavior**: If <unwanted condition>, then the system shall <response>.
- **Optional Feature**: Where <feature is enabled>, the system shall <response>.

### REQ-1: Native signal ingestion

**User Story**: As a power user, I want Token Shield to build on what Claude Code already knows about my cache, so that its picture matches Claude Code's and doesn't duplicate or contradict it.

Source: derived from the analysis design doc (§0 finding 1, §10) and `product.md` (Value proposition, Constraints).

- **1.0.1 (Ubiquitous)**: The system shall take cache state from native signals (`prompt_cache.warm`, `ttl`, `expires_at`, `misses`, `expected_rebuilds`, `hit_ratio`, `recache_tokens_if_cold`, `last_miss_cause`, `miss_causes`) before any value it derives itself.
- **1.0.2 (Ubiquitous)**: The system shall record each native snapshot as numbers, timestamps, model IDs and cause names only, never prompt or response content.
- **1.0.3 (Event-Driven)**: When a native snapshot arrives with a TTL different from the previous snapshot's, the system shall record a TTL-change event.
- **1.0.4 (Unwanted Behavior)**: If the running Claude Code version is below v2.1.260, then the system shall disable its cache features and tell the user the minimum version required.
- **1.0.5 (State-Driven)**: While `prompt_cache` is absent (no main-conversation response yet), the system shall report the cache state as unknown, with that reason.
- **1.0.6 (Unwanted Behavior)**: If `prompt_cache.caching_observed` is false, then the system shall report that prompt caching appears off or unreported, and shall not report the cache as cold.
- **1.0.7 (Unwanted Behavior)**: If a native field is missing or malformed, then the system shall lower the certainty tier of anything that depends on it, and shall not substitute zero.

#### Acceptance Criteria
- **1.1**: Given a statusline payload with `prompt_cache.warm = true`, `ttl = "1h"` and an `expires_at`, the reported state, TTL and expiry equal those values.
- **1.2**: The local store contains no prompt or response text after a session that included prompts, tool results and responses (verified by searching the store for known strings from the session).
- **1.3**: A payload sequence whose `ttl` changes from `1h` to `5m` produces exactly one TTL-change event.
- **1.4**: Running under a reported version of `2.1.259` disables cache features and shows a message naming v2.1.260.
- **1.5**: A payload without `prompt_cache` yields state `UNKNOWN`, with a reason mentioning that no response has been received yet.
- **1.6**: A payload with `caching_observed = false` yields state `UNKNOWN` (never `COLD`), with a reason saying caching appears off.
- **1.7**: A payload with `expires_at` missing yields an expiry tagged at a lower tier (or none), never an expiry of 0.

### REQ-2: Cache state assessment

**User Story**: As a power user, I want one clear cache state with an honest confidence, so that I can trust what Token Shield tells me.

Source: derived from the analysis design doc (§2, §5, §6) and `product.md` (Value proposition: "never more confident than the evidence").

- **2.0.1 (Ubiquitous)**: The system shall classify the main conversation's cache as exactly one of `HOT`, `EXPIRING`, `UNCERTAIN`, `INVALIDATED`, `COLD` or `UNKNOWN`, using the conditions in the analysis design doc §5.
- **2.0.2 (Ubiquitous)**: The system shall attach to each assessment: a probability that the next request reads the cache, with an interval; a confidence level (`HIGH`, `MEDIUM` or `LOW`); and the ordered list of rules and estimates that produced it, each tagged with its certainty tier.
- **2.0.3 (Ubiquitous)**: The system shall treat documented invalidating actions as rebuild-expected and documented no-op actions as having no effect, per the invalidation table in the analysis design doc §6.3.
- **2.0.4 (Event-Driven)**: When a documented invalidating action occurs after the last request (model switch, fast-mode toggle, effort change on a model without per-message effort, tool-definition change with tools loaded upfront, compaction, image-batch removal), the system shall classify the state as `INVALIDATED` and name the cause.
- **2.0.5 (State-Driven)**: While the current time is within the boundary margin of `expires_at`, the system shall classify the state as `UNCERTAIN`.
- **2.0.6 (Ubiquitous)**: The system shall never display a probability above "≥ 99%" or below "≤ 1%", and shall not display a probability in the `UNKNOWN` state.
- **2.0.7 (Ubiquitous)**: The system shall describe future requests as "expected" and reserve "hit" and "miss" for past requests.
- **2.0.8 (Ubiquitous)**: The system shall present Claude Code's `likely_server_side` miss cause as Claude Code's estimate, not as a fact.
- **2.0.9 (Unwanted Behavior)**: If the newest native snapshot is more than 60 seconds older than the assessment, then the system shall mark the assessment stale and lower its confidence to `LOW`.
- **2.0.10 (Unwanted Behavior)**: If the system's own expiry computation and the native `expires_at` disagree by more than the margin, then the system shall record a drift event and lower its confidence to at most `MEDIUM`.

#### Acceptance Criteria
- **2.1**: For each of the six states, a fixture of native snapshots and events produces that state and no other.
- **2.2**: Every rendered figure in verbose output carries a `[measured]`, `[inferred]` or `[estimated]` tag.
- **2.3**: Editing `.mcp.json` or a CLAUDE.md file mid-session leaves the state unchanged (no `INVALIDATED`, no warning).
- **2.4**: A model switch event after the last request produces `INVALIDATED`, with the cause "model switch".
- **2.5**: Effort changes produce `INVALIDATED` on a model without per-message effort, and no state change on Opus 5.5 with subscription or API-key auth.
- **2.6**: A computed probability of 0.9995 renders as "≥ 99%"; 0.0004 renders as "≤ 1%"; the `UNKNOWN` state renders no percentage.
- **2.7**: An assessment built from a 61-second-old snapshot shows a stale marker and confidence `LOW`.
- **2.8**: No user-facing string about a future request uses the words "hit" or "miss" (checked against the string catalog).

### REQ-3: Cost model

**User Story**: As a power user on any billing setup, I want to see what my next turn will cost if the cache is warm versus cold, so that I can judge whether a lever is worth pulling.

Source: derived from the analysis design doc (§7) and `product.md` (Target users, Constraints: pricing drift).

- **3.0.1 (Ubiquitous)**: The system shall compute the next-turn cost if the cache is warm, the cost if it is cold, and the difference between them, from the prefix size, the model, the TTL and a price table.
- **3.0.2 (Ubiquitous)**: The system shall show costs in tokens. Where the session bills API key, usage credits or a cloud provider, it shall also show dollars. Where the session is on a subscription, it shall also show the estimated share of the 5-hour usage window, tagged `[estimated]`.
- **3.0.3 (Ubiquitous)**: The system shall label dollar figures as API-equivalent or provider-priced as applicable, and show the date of the price table used.
- **3.0.4 (Event-Driven)**: When Claude Code supplies its own cost estimate for an action (for example `estimated_cache_write_usd` on resume or before a model switch), the system shall show Claude Code's estimate in place of its own.
- **3.0.5 (Ubiquitous)**: The system shall read prices from a versioned local price table that the user can override, and shall never fetch prices from the network without the user's action.
- **3.0.6 (Ubiquitous)**: The system shall support per-provider prices and tiered prices (prices that change above a token threshold).
- **3.0.7 (Ubiquitous)**: The system shall exclude output tokens, tool loops and subagent requests from the headline next-turn cost.

#### Acceptance Criteria
- **3.1**: For Opus 5.5, a 1-hour TTL and an 812,470-token prefix, the cold cost is $6.50 ± $0.01 and the warm cost is $0.16–$0.18 at the 2026-11-03 prices.
- **3.2**: A subscription session shows tokens and an estimated 5-hour-window share tagged `[estimated]`, and no unlabelled dollar figure.
- **3.3**: When a `PreModelSwitch` input carries `estimated_cache_write_usd`, the displayed switch cost equals that value.
- **3.4**: A user price override for a model changes the displayed costs for that model on the next render.
- **3.5**: With the network disabled, every cost displays normally.

### REQ-4: Lever catalog and recommendation

**User Story**: As a power user at a decision point, I want every available lever priced side by side with one recommended, so that I always know the cheapest next move.

Source: derived from `product.md` (Value proposition, journey 3) and the analysis design doc (§8.1, §14); the lever list is new, from the 2026-11-25 lever research.

- **4.0.1 (Ubiquitous)**: The system shall maintain a lever catalog covering at least: continue now, `/compact` (optionally with focus instructions), `/clear` (optionally after `/rename`), `/rewind`, `/recap`, `/btw`, budgeted keep-alive, probe, main and subagent TTL settings, and the choice of model, effort and fast mode.
- **4.0.2 (Ubiquitous)**: For each lever applicable to the current state, the system shall show its expected cost now, its expected effect on later turns (for example a smaller prefix after compaction), its certainty tier, and a one-line explanation of when to use it.
- **4.0.3 (Ubiquitous)**: The system shall recommend exactly one lever, or state that no action is needed, and give the reason.
- **4.0.4 (Ubiquitous)**: The system shall describe `/recap` as cache-safe but not cache-saving: it does not invalidate the cache and does not shrink the prefix.
- **4.0.5 (State-Driven)**: While the state is `COLD` or `INVALIDATED`, the system shall compare continuing (a full re-cache), `/compact` (a cold summarization, then a smaller prefix), `/clear` with a handoff, and `/rewind` where an earlier cached prefix exists.
- **4.0.6 (Unwanted Behavior)**: If a lever's cost cannot be estimated, then the system shall still list the lever, mark its cost unknown, and not recommend it on cost grounds.
- **4.0.7 (Ubiquitous)**: The system shall record every recommendation with the alternatives' estimated costs, for later hindsight evaluation (REQ-14).

#### Acceptance Criteria
- **4.1**: In a `COLD` fixture with an 812k-token prefix, the comparator lists continue, `/compact`, `/clear` and `/recap` with costs, and marks exactly one as recommended.
- **4.2**: In a `HOT` fixture with ample time left, the recommendation is "no action needed".
- **4.3**: `/recap`'s explanation states that it neither invalidates the cache nor reduces the prefix.
- **4.4**: A lever with an unknown cost appears with "cost unknown" and is not the recommended lever.
- **4.5**: Each recommendation is stored with its alternatives and their estimated costs.

### REQ-5: Lever execution with consent

**User Story**: As a power user, I want to run the lever I chose from where I chose it, so that acting on advice is one step and never happens without me.

Source: derived from `product.md` (Value proposition, Non-goals: "Nothing automatic", "No request tampering"); new.

- **5.0.1 (Event-Driven)**: When the user picks a command lever (`/compact`, `/clear`, `/rewind`, `/recap`, `/btw`), the system shall run that Claude Code command as if the user had typed it.
- **5.0.2 (Event-Driven)**: When the user picks a settings lever (a TTL, `idleCompaction`, the auto-compact window), the system shall show the exact setting, its scope and its value, and change it only after explicit confirmation.
- **5.0.3 (Ubiquitous)**: The system shall never compact, clear, rewind, change settings, or spend tokens (probe, keep-alive) without the user's go-ahead, given either at that moment or as a standing opt-in with an explicit budget.
- **5.0.4 (Ubiquitous)**: The system shall never modify the requests Claude Code sends: no proxy, and no changes to the system prompt, tools or messages.
- **5.0.5 (Unwanted Behavior)**: If a lever's command fails or is unavailable, then the system shall report the failure and leave the session unchanged.

#### Acceptance Criteria
- **5.1**: Choosing `/compact` from the comparator produces the same session result as typing `/compact`.
- **5.2**: Choosing a TTL lever shows the setting name, scope and value, and the settings file is unchanged until the user confirms.
- **5.3**: Across a full test session with default configuration, Token Shield initiates no compaction, clear, rewind, settings change or API request on its own.
- **5.4**: No Token Shield code path registers a system-prompt, tool-description or message-rewriting hook (checked by `claude plugin validate` output and a code search).

### REQ-6: `/cache-check` command

**User Story**: As a power user, I want an on-demand cache check that never touches my conversation, so that checking costs nothing and changes nothing.

Source: derived from the seed `cache-check-command.md` and the analysis design doc (§8.1, §8.2, §8.4, §8.5).

- **6.0.1 (Event-Driven)**: When the user runs `/cache-check`, the system shall show: the state, probability and interval, confidence, last request time, expiry, TTL, prefix size, warm and cold costs, pending events, the last miss and its cause, and one recommendation.
- **6.0.2 (Event-Driven)**: When the user runs `/cache-check --verbose`, the system shall also show a timeline of recent main-conversation requests, the native and computed expiry with any drift, pending events with their basis, the full rationale with certainty tags, and calibration for the current bucket.
- **6.0.3 (Event-Driven)**: When the user runs `/cache-check --diff`, the system shall show what differs between the last two requests, or what is pending for the next one: the native miss-cause details, changes in model, effort, speed, thinking or TTL, and pending events.
- **6.0.4 (Event-Driven)**: When the user runs `/cache-check history`, the system shall show the history views defined in REQ-14, accepting `--session`, `--all`, `--since`, `--misses` and `--calibration`.
- **6.0.5 (Ubiquitous)**: The system shall show `/cache-check` output to the user only, never adding it to any request to the model, and shall make no API request except under `--probe` (REQ-7).

#### Acceptance Criteria
- **6.1**: After `/cache-check`, the next API request contains no text from the command's output (verified by comparing request token counts or captured request content in a test session).
- **6.2**: `/cache-check` in a session makes zero API requests (the session's request count and cost are unchanged).
- **6.3**: `--verbose` output includes the timeline, both expiry values, and a tier tag on every figure.
- **6.4**: `--diff` after a model switch names the model change.
- **6.5**: `history --since 7d --misses` lists only misses from the last seven days.

### REQ-7: Probe

**User Story**: As a power user facing a genuinely uncertain cache, I want to measure it for a known price, so that I don't have to guess at the boundary.

Source: derived from the seed `cache-check-command.md` (probe mode), reworked by the analysis design doc (§0 finding 6, §8.3).

- **7.0.1 (Event-Driven)**: When the user runs `/cache-check --probe`, the system shall show the probe's cost if the cache is warm and if it is cold, and its side effect (the cache is refreshed), and shall proceed only after explicit confirmation.
- **7.0.2 (Ubiquitous)**: The system shall probe by re-sending the main conversation's exact last request prefix through Claude Code's own fork mechanism, with a minimal prompt and without changing effort.
- **7.0.3 (Event-Driven)**: When a probe completes, the system shall report the tokens read from cache, written and uncached, the outcome, the actual cost, and the new expiry, and shall record the result for calibration.
- **7.0.4 (Unwanted Behavior)**: If the state is `COLD` or `INVALIDATED` with `HIGH` confidence, or `HOT` with more than 5 minutes left, then the system shall decline to probe and explain why, unless the user passes `--force`.
- **7.0.5 (Unwanted Behavior)**: If an exact-prefix probe is not available (for example outside the mod), then the system shall say so and shall not approximate the request.
- **7.0.6 (Ubiquitous)**: The system shall never run a probe on a schedule or without confirmation.

#### Acceptance Criteria
- **7.1**: `--probe` in an `UNCERTAIN` fixture shows both quoted costs and sends nothing until the user confirms.
- **7.2**: A confirmed probe on a warm cache reports `cache_read_input_tokens` ≥ 95% of the prefix and a new expiry about one TTL later.
- **7.3**: `--probe` in a `COLD`/`HIGH` fixture is declined with a reason; `--probe --force` proceeds to the confirmation step.
- **7.4**: `tshield check --probe` outside the mod explains that an exact-prefix probe needs the mod and makes no request.

### REQ-8: Status segment

**User Story**: As a power user, I want the cache state always visible while I work, so that I notice trouble without asking.

Source: derived from the seed `cache-monitor-design.md` and the analysis design doc (§8.6, §9); `product.md` journey 1.

- **8.0.1 (Ubiquitous)**: The system shall show a status segment with the state, the prefix size, and either the expiry time (when warm) or the cause and rebuild cost (when not).
- **8.0.2 (Ubiquitous)**: The system shall show the expiry as a wall-clock time, and show a countdown only where a timer is known to refresh it.
- **8.0.3 (State-Driven)**: While the state is `EXPIRING`, `COLD` or `INVALIDATED`, the system shall include the rebuild cost in the segment.
- **8.0.4 (Ubiquitous)**: The system shall leave any existing user statusline content intact.

#### Acceptance Criteria
- **8.1**: In a `HOT` fixture the segment reads like `● cache HOT · 812k · warm until 16:40`.
- **8.2**: In a `COLD` fixture the segment includes the rebuild cost.
- **8.3**: With a pre-existing statusline command configured, its output still appears unchanged alongside the segment.

### REQ-9: Notifications and band

**User Story**: As a power user, I want to be told when the cache state changes in a way that matters, without being nagged, so that I can act in time.

Source: derived from the seed `cache-monitor-design.md` and the analysis design doc (§8.6).

- **9.0.1 (Event-Driven)**: When the state changes to `EXPIRING`, `COLD`, `INVALIDATED` or `UNCERTAIN`, or the TTL changes, the system shall show one toast for that transition.
- **9.0.2 (Ubiquitous)**: The system shall show at most one toast per transition and at most one toast per 5 minutes, except at the critical level.
- **9.0.3 (State-Driven)**: While the state is `EXPIRING`, `COLD` or `INVALIDATED`, the system shall show an above-prompt band with the state, the cost and the recommended lever. It shall hide the band in `HOT`.
- **9.0.4 (Ubiquitous)**: The system shall assign each notification a level (info, warning, critical), and the user shall be able to mute levels.
- **9.0.5 (Event-Driven)**: When the cache will reach `EXPIRING` with no new event to trigger a render, the system shall fire a timer so the transition is shown on time.

#### Acceptance Criteria
- **9.1**: A `HOT → EXPIRING → COLD` fixture produces exactly two toasts.
- **9.2**: Rapid state flapping within 5 minutes produces no more than one non-critical toast.
- **9.3**: The band is visible in `COLD` and absent in `HOT`.
- **9.4**: With warnings muted, an `EXPIRING` transition produces no toast.
- **9.5**: In an idle session, the `EXPIRING` toast appears within 5 seconds of the warn-window start, with no user input.

### REQ-10: Guard before invalidating actions

**User Story**: As a power user, I want to see the cost of a model, effort or fast-mode switch, or a plugin reload, before it happens, so that I don't throw away a warm cache by accident.

Source: derived from `product.md` (journey 2, goal 2) and the analysis design doc (§6.3); new.

- **10.0.1 (Event-Driven)**: When the user starts a model switch while the cache is warm, the system shall show the rebuild cost and any cheaper alternative (for example, a subagent on the other model for a one-off task) before the switch takes effect.
- **10.0.2 (Event-Driven)**: When the user changes effort on a model without per-message effort, or toggles fast mode, while the cache is warm, the system shall show the rebuild cost before the next request.
- **10.0.3 (Ubiquitous)**: The system shall leave Claude Code's own warm-cache confirmation as it is, neither replacing nor suppressing it, and shall show its own information alongside it.
- **10.0.4 (Ubiquitous)**: The system shall label everything it adds around a native prompt or message as coming from Token Shield, so the user can always tell Claude Code's text from Token Shield's.
- **10.0.5 (State-Driven)**: While the cache is already cold, the system shall not warn about an invalidating action.

#### Acceptance Criteria
- **10.1**: `/model` with a warm 812k cache shows Claude Code's unchanged confirmation and, alongside it, the rebuild cost labelled as Token Shield's, before the switch takes effect.
- **10.2**: `/model` with a cold cache shows no Token Shield warning.
- **10.3**: An effort change on Opus 5.5 with a subscription shows no warning; on Sonnet 5 it shows the cost.
- **10.4**: Every Token Shield toast, band and row shown during a switch carries the Token Shield name or mark.

### REQ-11: Resume guidance

**User Story**: As a power user reopening an old session, I want to see what continuing will cost and my alternatives before I send anything, so that I can decide whether it's worth it.

Source: derived from `product.md` (journey 4, problem 3).

- **11.0.1 (Event-Driven)**: When a session is resumed or forked and the cache is likely expired, the system shall show the cold re-cache cost (Claude Code's estimate when it provides one) and the options: continue, `/compact`, `/clear` with a handoff, and `/recap` first to get reoriented.
- **11.0.2 (Event-Driven)**: When a session is resumed within its TTL, the system shall show that the cache is still warm until the expiry time and offer no warning.
- **11.0.3 (Ubiquitous)**: The system shall show resume guidance to the user only, without adding context to the session.

#### Acceptance Criteria
- **11.1**: Resuming a fixture session last active 3 hours ago shows the cold cost and the four options before the first prompt.
- **11.2**: Resuming a session last active 10 minutes ago on a 1-hour TTL shows "warm until HH:MM" and no warning.
- **11.3**: The first request after resume carries no Token Shield text.

### REQ-12: Submit gate

**User Story**: As a power user, I want a prompt that would trigger an expensive rebuild held for confirmation, so that I never pay a large rebuild without knowing.

Source: derived from `product.md` (journey 5, goal 2) and the analysis design doc (§8.6).

- **12.0.1 (Event-Driven)**: When the user submits a prompt while the state is `COLD` or `INVALIDATED` and the rebuild cost exceeds the threshold, the system shall hold the prompt and show the cost and the recommended lever.
- **12.0.2 (Event-Driven)**: When the user resubmits the same prompt within 60 seconds of a hold, the system shall let it through.
- **12.0.3 (Ubiquitous)**: The system shall never alter the prompt text and never add context to it.
- **12.0.4 (Optional Feature)**: Where the user has turned the gate off, the system shall show a warning instead of holding the prompt.
- **12.0.5 (Unwanted Behavior)**: If the gate cannot determine the state (`UNKNOWN`), then the system shall let the prompt through.
- **12.0.6 (Ubiquitous)**: The gate shall be on by default, with the default threshold.

#### Acceptance Criteria
- **12.1**: Submitting in a `COLD` fixture with a $6.50 rebuild holds the prompt and shows $6.50.
- **12.2**: Resubmitting the identical prompt within 60 seconds sends it; after 61 seconds, it is held again.
- **12.3**: A held, then released prompt reaches the model byte-identical to what was typed.
- **12.4**: In an `UNKNOWN` state the prompt is never held.
- **12.5**: A fresh install with no configuration holds a prompt in the `COLD` fixture from 12.1.

### REQ-13: Visualizers

**User Story**: As a power user, I want visual views of my cache, so that I understand how to optimize it, not just what it is right now.

Source: new, from the 2026-11-25 visualizer proposal; `product.md` journey 6.

- **13.0.1 (Event-Driven)**: When the user opens the prefix map, the system shall draw each recent main-conversation request as a bar split into layers (system and tools, project context, conversation), colored by tokens read from cache, written, and uncached, with rebuilds labelled by cause.
- **13.0.2 (Event-Driven)**: When the user opens the expiry runway, the system shall draw a timeline with the current time, the warn window, the expiry and its uncertainty margin, and the cost of acting before versus after expiry.
- **13.0.3 (Event-Driven)**: When the user opens the lever comparator, the system shall draw the levers from REQ-4 side by side with cost now, effect on later turns, certainty and the recommendation, and let the user run one (REQ-5).
- **13.0.4 (Event-Driven)**: When the user opens the context composition view, the system shall show what makes up the current prefix by category, and mark which parts are stable and which change each turn.
- **13.0.5 (Event-Driven)**: When the user opens the history dashboard, the system shall show re-cache spend by cause over time, the distribution of idle gaps against the TTL, recommendation outcomes, and calibration (REQ-14).
- **13.0.6 (Ubiquitous)**: The system shall convey state with text or symbols as well as color, so no view depends on color alone.
- **13.0.7 (Ubiquitous)**: The system shall adapt each view to the terminal width, down to 80 columns.

#### Acceptance Criteria
- **13.1**: With a fixture of five requests including one compaction, the prefix map shows five bars and labels the rebuild "compaction".
- **13.2**: The expiry runway in an `EXPIRING` fixture shows the current time inside the warn window, plus both before and after costs.
- **13.3**: Running a lever from the comparator has the same effect as choosing it via `/cache-check` (5.1).
- **13.4**: Each view is legible at 80 columns and in monochrome (screenshot review).
- **13.5**: The history dashboard's spend by cause sums to the total re-cache spend for the period.

### REQ-14: History, calibration and advice evaluation

**User Story**: As a power user, I want to see where my re-cache spend went and whether Token Shield's estimates and advice were right, so that I can trust it and improve my habits.

Source: derived from the analysis design doc (§6.6, §8.5) and `product.md` (Goals 1, 3, 4).

- **14.0.1 (Ubiquitous)**: The system shall keep a local history of main-conversation requests, events, assessments, recommendations and probe results across sessions.
- **14.0.2 (Ubiquitous)**: The system shall attribute each re-cache to a cause (TTL expiry, model/effort/speed switch, tool change, compaction, server-side per Claude Code, unexplained) and report spend per cause.
- **14.0.3 (Ubiquitous)**: The system shall report avoidable spend: expiry re-caches where the user returned within twice the TTL, and invalidating actions taken while warm.
- **14.0.4 (Event-Driven)**: When the main-conversation request after an assessment completes, the system shall record the predicted probability against the actual outcome.
- **14.0.5 (Ubiquitous)**: The system shall show a reliability table and Brier score, overall and per Claude Code version, model and TTL.
- **14.0.6 (Event-Driven)**: When the observed miss rate in `HOT` exceeds the upper bound of its stated interval, the system shall raise a calibration drift alert and widen its intervals until the rate is back inside.
- **14.0.7 (Ubiquitous)**: The system shall evaluate each recommendation in hindsight, comparing the cost of the lever taken with the estimated costs of the alternatives, and report the share of recommendations that were cheapest.
- **14.0.8 (Ubiquitous)**: The system shall establish a baseline of avoidable spend from the user's sessions before installation, where history is available, so the reduction can be measured.
- **14.0.9 (Ubiquitous)**: The system shall let the user delete all stored history.

#### Acceptance Criteria
- **14.1**: Per-cause spend in a fixture history sums to the total re-cache spend.
- **14.2**: A fixture with a 70-minute gap on a 1-hour TTL counts that re-cache as avoidable; a 3-hour gap does not.
- **14.3**: The reliability table's counts match the number of recorded predictions.
- **14.4**: A fixture with HOT-state misses above the interval raises one drift alert.
- **14.5**: The advice report shows the cheapest-in-hindsight share for a fixture with known outcomes.
- **14.6**: Running the delete command leaves the history store empty.

### REQ-15: Keep-alive

**User Story**: As a power user stepping away, I want to keep the cache warm within a budget I set, so that I can choose to pay a little rather than a full rebuild.

Source: derived from the analysis design doc (§14 item 1); `product.md` Non-goals ("Nothing automatic", standing opt-in with budget).

- **15.0.1 (Optional Feature)**: Where the user has started a keep-alive with an end time and a budget, the system shall refresh the cache shortly before each expiry until the end time, the budget or the user's return, whichever comes first.
- **15.0.2 (Ubiquitous)**: The system shall show the keep-alive's estimated total cost before it starts and its spend so far while it runs.
- **15.0.3 (Event-Driven)**: When the user sends a prompt or the budget would be exceeded by the next refresh, the system shall stop the keep-alive.
- **15.0.4 (Ubiquitous)**: The system shall never start a keep-alive except at the user's request.

#### Acceptance Criteria
- **15.1**: A keep-alive with a $1 budget never spends more than $1 (fixture with simulated refresh costs).
- **15.2**: Sending a prompt stops the keep-alive before its next refresh.
- **15.3**: The cache stays warm across a 90-minute idle period with a keep-alive running on a 1-hour TTL (manual test).

### REQ-16: TTL advisor

**User Story**: As a power user, I want to know whether a different cache lifetime would have saved me money, so that I can set it well for how I actually work.

Source: derived from the analysis design doc (§14 item 4); new.

- **16.0.1 (Event-Driven)**: When the user opens the TTL advisor, the system shall compare the user's recorded idle-gap distribution and re-cache costs under the 5-minute and 1-hour TTLs, for the main conversation and for subagents.
- **16.0.2 (Ubiquitous)**: The system shall recommend a TTL per bucket only when the history covers enough sessions, and otherwise say there is not enough data.
- **16.0.3 (Ubiquitous)**: The system shall explain that subscriptions use the 1-hour TTL by default within plan usage, and the 5-minute TTL once on usage credits.

#### Acceptance Criteria
- **16.1**: A fixture where most gaps fall between 10 and 50 minutes on an API key recommends the 1-hour TTL, with the estimated savings.
- **16.2**: A fixture with fewer sessions than the minimum shows "not enough data".

### REQ-17: Absorbed `/compact` and `/clear` mod

**User Story**: As a user of the `session-info` mod, I want its `/COMPACT` and `/CLEAR` controls to live in Token Shield, so that one tool both runs these levers and advises when to use them.

Source: reverse-engineered from the `session-info` mod (`plugin/hooks/register.tsx`, `plugin/hooks/ui/metrics.tsx`, `plugin/hooks/ui/detail.tsx`, README "Metrics view"), read 2026-11-25. In that mod both controls sit on the current session's card, and `/COMPACT` also sits in the card's details.

- **17.0.1 (Event-Driven)**: When the user presses the compact control, the system shall run `/compact` at once, with no confirmation step (kept from `session-info`).
- **17.0.2 (Event-Driven)**: When the user presses the clear control once, the system shall arm it and show it as a highlighted `CONFIRM?`. When it is pressed again within 3 seconds, the system shall run `/clear` (kept from `session-info`).
- **17.0.3 (Event-Driven)**: When 3 seconds pass after arming without a second press, the system shall disarm the clear control and restore its label (kept from `session-info`).
- **17.0.4 (Ubiquitous)**: The system shall offer the compact and clear controls only for the current session, never for another session or a subagent (kept from `session-info`).
- **17.0.5 (Ubiquitous)**: The system shall offer the compact and clear controls in the lever comparator (REQ-13.0.3) and in the `/cache-check` lever list, each with Token Shield's guidance beside it: cost now, effect afterwards, and whether it is the recommended lever (new).

#### Acceptance Criteria
- **17.1**: One press of the compact control produces the same session result as typing `/compact`, with no confirmation shown.
- **17.2**: One press of the clear control shows `CONFIRM?` highlighted and runs nothing; a second press within 3 seconds runs `/clear`.
- **17.3**: After a first press of the clear control and 3 seconds without a second press, the label returns to its unarmed text, and a later single press arms it again rather than running `/clear`.
- **17.4**: No compact or clear control appears for another session or a subagent.
- **17.5**: Both controls in the lever comparator show their current cost and effect, and the recommended one is marked.

### REQ-18: Statusline script companion

**User Story**: As a power user, I want the status segment available even where the mod isn't loaded, so that I keep the basic picture regardless.

Source: derived from the analysis design doc (§3.2) and the surface decision (mod + statusline + CLI).

- **18.0.1 (Ubiquitous)**: The system shall provide a statusline command that renders the status segment (REQ-8) from the statusline JSON alone.
- **18.0.2 (Ubiquitous)**: The statusline command shall be able to wrap an existing user statusline command and show both outputs.

#### Acceptance Criteria
- **18.1**: With the mod disabled, the statusline command shows the segment for a `HOT` fixture payload.
- **18.2**: Wrapping an existing command shows both outputs, the existing one unchanged.

### REQ-19: `tshield` command-line tool

**User Story**: As a power user, I want to check the cache and history from any terminal and from scripts, so that I can use Token Shield outside the session view.

Source: derived from the analysis design doc (§3.2, §8.1).

- **19.0.1 (Ubiquitous)**: The system shall provide `tshield check`, `tshield history` and `tshield calibration` with the same content as the in-session views.
- **19.0.2 (Ubiquitous)**: The system shall offer `--json` output for every `tshield` command.
- **19.0.3 (Ubiquitous)**: `tshield check` shall exit with code 0 (`HOT`), 10 (`EXPIRING`), 20 (`UNCERTAIN`), 30 (`INVALIDATED`), 40 (`COLD`) or 50 (`UNKNOWN`).

#### Acceptance Criteria
- **19.1**: `tshield check --json` output validates against the published schema.
- **19.2**: `tshield check` exits with the code matching each state's fixture.

### REQ-20: Privacy and context hygiene

**User Story**: As a power user, I want Token Shield to keep my data local and never pollute my conversation, so that installing it is safe and free.

Source: derived from `product.md` (Constraints: privacy; Goals 4) and the analysis design doc (§3.3, §8.6).

- **20.0.1 (Ubiquitous)**: No Token Shield surface shall write context: no transcript messages sent to the model, no injected hook context, no command output sent in requests.
- **20.0.2 (Ubiquitous)**: The system shall store data only on the user's machine, in a location outside any project directory.
- **20.0.3 (Ubiquitous)**: The system shall make network requests only for an action the user approved (a probe or keep-alive), and only through Claude Code.
- **20.0.4 (Ubiquitous)**: The system shall not store prompt text, response text, file contents or tool results.

#### Acceptance Criteria
- **20.1**: Over a scripted session that exercises every Token Shield surface, total input tokens equal those of the same session with Token Shield disabled, apart from approved probe or keep-alive requests.
- **20.2**: With network access monitored, Token Shield makes no connection outside approved actions.
- **20.3**: The store sits under the user's home directory and contains no strings from the session's prompts or responses.

### REQ-21: Performance and robustness

**User Story**: As a power user running very large sessions, I want Token Shield to be fast and never break my session, so that I don't pay for it in latency or stability.

Source: derived from the analysis design doc (§3.3, §11, §12).

- **21.0.1 (Ubiquitous)**: The statusline command shall render within 50 ms at the 95th percentile, in sessions up to 1M tokens.
- **21.0.2 (Ubiquitous)**: Token Shield hooks shall add no more than 20 ms at the 95th percentile to prompt submission.
- **21.0.3 (Unwanted Behavior)**: If any Token Shield component fails, then the system shall fail open: it shall not block prompts, commands or rendering, and it shall log the failure to the debug log.
- **21.0.4 (Ubiquitous)**: The system shall read transcript files only incrementally and only for history backfill, never on the status render path.
- **21.0.5 (Ubiquitous)**: The system shall run on Windows, macOS and Linux.

#### Acceptance Criteria
- **21.1**: A benchmark with a 1M-token session fixture measures p95 statusline render ≤ 50 ms.
- **21.2**: A benchmark measures p95 submit-hook overhead ≤ 20 ms.
- **21.3**: A forced exception in the assessor leaves prompts submitting normally and writes one debug-log entry.
- **21.4**: The test suite passes on Windows, macOS and Linux.

### REQ-22: Configuration

**User Story**: As a power user, I want to tune thresholds, warnings and prices, so that Token Shield fits my budget and tolerance for interruptions.

Source: derived from the analysis design doc (§8.6).

- **22.0.1 (Ubiquitous)**: The system shall let the user configure: the threshold, the warn windows per TTL, the gate on or off, muted notification levels, price overrides, the glyph set (Unicode or ASCII), and keep-alive defaults.
- **22.0.2 (Unwanted Behavior)**: If the configuration contains an invalid value, then the system shall use that setting's default and tell the user which setting was invalid.

#### Acceptance Criteria
- **22.1**: Changing the threshold to $5 stops the gate from holding a $4 rebuild.
- **22.2**: An invalid threshold value produces a message naming the setting, and the default applies.
- **22.3**: Setting the ASCII glyph set renders `[cache HOT 812k ->16:40]`-style output.

## 3. Open Questions

None.

Resolved 2026-11-25:
- The submit gate holds prompts by default (REQ-12.0.6).
- Keep-alive is a standing opt-in with an end time and a budget, with no per-refresh confirmation (REQ-15).
- The plan-share estimate is included, tagged `[estimated]` (REQ-3.0.2).
- Claude Code's own switch confirmation is kept unchanged, and Token Shield's added information is labelled as its own (REQ-10.0.3, 10.0.4).
- The behavior to absorb from `session-info` is the compact and clear controls (REQ-17).
- `session-info` keeps its own `/COMPACT` and `/CLEAR` buttons; both mods offer the controls.
