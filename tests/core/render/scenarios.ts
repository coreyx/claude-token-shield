/**
 * Synthetic sessions for the renderer tests and golden files, one per state,
 * timed like the analysis mockups: requests from 14:02 to 15:40:02 UTC and a
 * 1-hour cache warm until 16:40:02. Every value is made up.
 */

import { assess } from '../../../plugin/core/assess/assess'
import type { Assessment, AssessParams, CacheState } from '../../../plugin/core/assess/types'
import type { BillingMode, NextTurnCost } from '../../../plugin/core/cost/cost'
import { nextTurnCost } from '../../../plugin/core/cost/cost'
import { initialState, reduce } from '../../../plugin/core/model/reduce'
import { parseSnapshot } from '../../../plugin/core/model/snapshot'
import type { Fact, SessionState } from '../../../plugin/core/model/types'
import { quoteLevers } from '../../../plugin/core/recommend/levers'
import { recommend } from '../../../plugin/core/recommend/recommend'
import type { CheckMode, CheckView } from '../../../plugin/core/view/view'
import { checkView } from '../../../plugin/core/view/view'
import { payload, request } from '../model/fixtures'
import { prices, rules } from '../helpers'

/** 2026-01-01 at hh:mm:ss UTC, epoch ms. */
export const utc = (hh: number, mm: number, ss = 0) => Date.UTC(2026, 0, 1, hh, mm, ss)

const params: AssessParams = { rules, env: { provider: 'firstParty', toolSearch: true, experimentalBetasDisabled: false } }

/** The session's main requests: a cold start, two reads, a tools-changed miss, a compaction rebuild, a read. */
function requests(): Fact[] {
  const rows: [number, number, number, number][] = [
    [utc(14, 2, 11), 0, 402000, 3000],
    [utc(14, 3, 40), 402000, 6000, 2000],
    [utc(14, 31, 5), 14000, 396000, 1000],
    [utc(15, 12, 47), 0, 61000, 2000],
    [utc(15, 40, 2), 61000, 3000, 3000],
  ]
  return rows.map(([ts, read, write, input]) => ({ kind: 'request', request: request(ts, { usage: { input, read, write5m: 0, write1h: write, output: 600 } }) }))
}

/** A scenario: the session, when it is assessed, and the snapshot fields that shape it. */
interface Scenario {
  readonly now: number
  readonly cache: Record<string, unknown>
  readonly overrides?: Record<string, unknown>
  readonly extra?: Fact[]
}

const WARM_UNTIL = utc(16, 40, 2) / 1000

const SCENARIOS: Record<CacheState, Scenario> = {
  HOT: { now: utc(15, 52, 2), cache: { expires_at: WARM_UNTIL } },
  EXPIRING: { now: utc(16, 33, 0), cache: { expires_at: WARM_UNTIL } },
  UNCERTAIN: { now: utc(16, 40, 0), cache: { expires_at: WARM_UNTIL } },
  INVALIDATED: {
    now: utc(15, 52, 2),
    cache: { expires_at: WARM_UNTIL },
    extra: [{ kind: 'event', event: { ts: utc(15, 50), kind: 'model_switch', detail: { from: 'claude-opus-5-5', to: 'claude-sonnet-5-5' } } }],
  },
  COLD: { now: utc(17, 30, 0), cache: { warm: false, expires_at: null } },
  UNKNOWN: { now: utc(15, 52, 2), cache: {}, overrides: { prompt_cache: undefined } },
}

/** Everything a renderer test needs for one state. */
export interface Built {
  readonly state: SessionState
  readonly a: Assessment
  readonly cost: NextTurnCost
  readonly view: (mode: CheckMode, billing?: BillingMode) => CheckView
}

/** Builds the scenario for `which`. */
export function build(which: CacheState): Built {
  const sc = SCENARIOS[which]
  const snapshot = parseSnapshot(payload(sc.overrides ?? {}, sc.cache), sc.now)
  const state = [...requests(), ...(sc.extra ?? []), { kind: 'snapshot', snapshot } as Fact].reduce(reduce, initialState())
  const a = assess(state, sc.now, params)
  const cost = nextTurnCost({ prefixTokens: 812470, model: 'claude-opus-5-5', ttl: '1h', provider: 'firstParty', at: sc.now }, prices)
  const quotes = quoteLevers(a, state, { prices, model: 'claude-opus-5-5', provider: 'firstParty', now: sc.now })
  const rec = recommend(a, quotes)
  return {
    state,
    a,
    cost,
    view: (mode, billing = 'api') => checkView({ a, s: state, quotes, rec, cost: a.state === 'UNKNOWN' ? null : cost, billing, mode }),
  }
}

export const STATES: readonly CacheState[] = ['HOT', 'EXPIRING', 'UNCERTAIN', 'INVALIDATED', 'COLD', 'UNKNOWN']
