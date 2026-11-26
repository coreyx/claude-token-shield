# Product: Token Shield

Token Shield is the product. This repository, `claude-token-shield`, is its implementation for Claude Code.

## Problem and motivation

In long Claude Code sessions (100k to 1M+ tokens), the expensive moments are prompt-cache rebuilds that nobody saw coming or chose deliberately. Three show up repeatedly:

1. **Silent invalidation.** A model, effort or fast-mode switch, a tool-definition change, or a compaction throws away a warm cache, and the next turn re-processes the whole prefix.
2. **Not knowing which lever is cheapest.** Continue, `/compact`, `/clear`, `/rewind`, `/recap` or `/btw` each has a different cache cost at any given moment, and none of them shows it.
3. **Resuming old sessions.** Reopening a large session pays a full re-cache before the user knows whether continuing it is even worth it.

Each rebuild costs subscription plan usage (the 5-hour and weekly windows) and, on an API key or usage credits, dollars. On Opus 5.5 an 800k-token rebuild costs about $6.50, against about $0.17 for a warm turn. Claude Code exposes the raw cache signals and asks for confirmation before some switches, but nothing prices the options side by side or recommends one.

## Target users

Public Claude Code power users who run long sessions (100k to 1M+ tokens) in the **terminal CLI**, on Windows, macOS or Linux. They are comfortable installing a mod and editing settings. They cover every billing setup, and each sees the cost differently:

| Segment | Cache lifetime (TTL) | Cost they feel |
|---|---|---|
| Subscription (Pro, Max, Team) | 1 hour on the main conversation | Share of the 5-hour and weekly usage windows |
| Subscription overflowing into usage credits | Drops to 5 minutes once credits are in use | Plan windows, then dollars |
| API key | 5 minutes by default (1 hour if configured) | Dollars at list price |
| Cloud provider (Amazon Bedrock, Google Cloud, Microsoft Foundry) | Varies by model and region | Dollars at the provider's prices |

The desktop app and IDE extensions are deferred; they are not part of the first release.

## Value proposition

**Always know the cheapest next move.** At any point in a session, Token Shield shows the levers available right now (continue, `/compact`, `/clear`, `/rewind`, `/recap`, `/btw`, keep-alive), each priced in plan share and dollars, and recommends one. The user can pull the chosen lever from the same place.

**Never more confident than the evidence.** Every figure is labelled measured, inferred or estimated. Uncertainty is shown as a range, or as "we don't know," never as false precision.

The alternatives each stop short:

- **Doing nothing:** rebuilds are discovered after they've been paid for.
- **Claude Code's own signals** (the `/usage` cache line, the statusline `prompt_cache` data, confirmation before a model or effort switch while the cache is warm): they report state and guard a couple of actions, but they don't price the alternatives or recommend one.
- **Hand-written statusline scripts:** these show numbers, with no guidance and no action.

Token Shield builds on Claude Code's native signals rather than duplicating them, and it never writes anything into the model's context.

## Goals and success criteria

The first public release succeeds when, for a user running it daily:

1. **Less avoidable spend.** Re-cache spend from avoidable causes drops measurably against the user's own baseline from before Token Shield. Target: at least 50% lower after two weeks of use, measured from Token Shield's own history.
2. **No unwarned rebuilds.** Every rebuild above the user's threshold that comes from a documented cause (an invalidating action, an expired cache at submit time, a cold resume) is flagged before it happens. Target: 100% coverage of documented causes.
3. **Good advice.** Judged in hindsight, the recommended lever was the cheapest option available. Target: at least 90% of recommendations.
4. **Honest numbers.** Observed cache outcomes fall inside the ranges Token Shield stated (calibration is tracked and visible to the user), and no Token Shield surface ever writes to the model's context.

Public adoption is not a goal for the first release. It ships when it holds up in daily use; installs come later.

## Non-goals

- **No request tampering.** Token Shield never changes what Claude Code sends to the API: no proxy, and no edits to the system prompt, tools or messages. It observes, advises, and runs only commands the user could run themselves.
- **Nothing automatic.** It never compacts, clears, or spends tokens (a probe or keep-alive) on its own. Every action needs the user's go-ahead, either in the moment or as a standing opt-in with an explicit budget.
- **Not a cost tracker.** No general usage or billing analytics; `/usage` and existing tools cover that. History covers cache behavior only.
- **Not for teams, yet.** No organization dashboards or shared telemetry in the first release. Single user, data kept on the user's machine.
- **Terminal only, for now.** The desktop app and IDE extensions are deferred.

## Core user journeys

All six are core. Detailed flows and screens belong to the design work, not here.

1. **Glance.** While working, a status segment shows the cache state, when it expires, and what a rebuild would cost. Most of the time nothing needs doing.
2. **Before an invalidating action.** The user goes to switch model, effort or fast mode, or to reload a plugin. Token Shield shows the rebuild cost and any cheaper alternative before the switch happens.
3. **"What now?"** At a natural break (the context is large, the task is changing), the user opens `/cache-check`, sees the levers priced side by side with one recommended, picks one, and Token Shield runs it.
4. **Resume an old session.** On resume, Token Shield shows the cold re-cache cost and the options (continue, `/compact`, `/clear` with a handoff, or `/recap` first to get reoriented) before anything is sent.
5. **Caught at submit.** The user sends a prompt while the cache is cold or invalidated and the rebuild cost is over their threshold. Token Shield holds it, shows the cost, and lets them confirm it or choose a lever instead.
6. **Learn and tune.** The user opens the visualizers and history to see where re-cache spend went, how their idle gaps compare to the cache lifetime, and how accurate Token Shield's estimates have been, then adjusts settings such as the TTL.

## Market and competitive context

Surveyed 2026-11-25 from public project descriptions. None of these tools was installed or tested.

| What exists | Examples | What it does | Gap Token Shield fills |
|---|---|---|---|
| Claude Code's own signals | statusline `prompt_cache` object (v2.1.251+), `/usage` "Prompt cache (main)" line, confirmation before a model or effort switch while the cache is warm | Reports hit ratio, misses, likely miss cause, warm or cold, expiry time, and tokens to re-cache | No pricing of alternatives, no recommendation, no guard at submit time, no history across sessions |
| Cache statusline scripts | [claude_cache_statusline](https://github.com/jimmc414/claude_cache_statusline), [cc-cache-monitor](https://github.com/Todmy/cc-cache-monitor) (state labels such as WARM, DRIFT, MISS, CLIFF, plus a cost-analysis CLI), [claude-code-statusline](https://github.com/MuQY1818/claude-code-statusline), a [cache-timer gist](https://gist.github.com/jesserobbins/ff344a13f3b90cddb8e6b1e19e7e604e) | Warm/cold state, expiry countdown, cold-start cost, hit-rate trends | They show state; they don't compare levers, act, or guard. Their health-style labels aren't tied to calibrated uncertainty. |
| Usage analyzers | [ccusage](https://npmjs.com/package/ccusage), [cc-token-usage](https://docs.rs/crate/cc-token-usage/1.2.2), [claude-usage-analyzer](https://github.com/SingggggYee/claude-usage-analyzer) | Historical token and cost reports, including cache read/write and cache savings | They look backward, at billing; they don't advise in the moment. Token Shield deliberately doesn't compete here (see Non-goals). |
| Context optimizers | [claude-context-optimizer](https://github.com/egorfedorov/claude-context-optimizer) (delegation hints, blocking redundant reads) | Reduce how much goes into context | Complementary: they shrink the prefix; Token Shield manages when it gets rebuilt |
| Guides | e.g. [compact or clear](https://stevekinney.com/experiments/compact-or-clear) and many cost-reduction articles | Rules of thumb ("clear when switching tasks") | Static advice. Some of it is outdated on the TTL (the 1-hour vs 5-minute default depends on billing). |

Token Shield's distinct position: an **advisor and actor**, not just a gauge. It prices the levers in the moment, recommends one, runs it with consent, guards the moments that matter (before switches, at resume, at submit), and labels its own certainty.

## Constraints and context

- **Platform dependency.** Token Shield is a Claude Code mod and relies on the mod API, which ships with the engine. Anthropic's stability commitment for that API is unconfirmed, so engine releases can break Token Shield.
- **Minimum version: Claude Code v2.1.260.** This guarantees the native `prompt_cache` data, including miss causes. Older versions are not supported.
- **Surface:** the terminal CLI on Windows, macOS and Linux. The statusline script and `cts` CLI are companions to the mod, not separate products.
- **Distribution:** a public GitHub repository, installable as a Claude Code plugin in one line. MIT license.
- **Privacy:** all data stays on the user's machine, as numbers, timestamps, model IDs and cause names, never prompt or response content. No network use except an action the user approves (a probe, or a budgeted keep-alive).
- **Pricing drift:** model prices and cache multipliers change. The price table is versioned, dated in the UI, and user-overridable. Organization `modelPricing` is respected where Claude Code exposes it.
- **Absorbing an existing mod:** the author's existing `/compact` and `/clear` mod is folded into Token Shield, so the release has to preserve that mod's behavior for its current user.

## Open questions for later

- **Plan-share pricing.** The per-turn effect on subscription usage windows can't be observed directly; Claude Code exposes only the `rate_limits` used percentages. How should "cost in plan share" be estimated and labelled?
- **Recap and idle compaction.** Do automatic recaps or idle compaction read the session's cache (refreshing its TTL), and what do they cost? Neither is documented; measure before advising on them.
- **Mod API stability.** What does Anthropic commit to? The answer decides how much of Token Shield lives in the mod versus the statusline script and CLI.
- **Judging "good advice."** The 90% target needs an agreed method for computing, in hindsight, what each alternative lever would have cost.
- **Keep-alive.** Is a budgeted, opt-in keep-alive consistent with "nothing automatic," or should every refresh be confirmed?
- **The existing mod.** Its scope and behavior, to be read once its location is shared.
