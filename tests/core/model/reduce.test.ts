import { describe, expect, it } from 'vitest'

import { initialState, reduce } from '../../../plugin/core/model/reduce'
import { parseSnapshot } from '../../../plugin/core/model/snapshot'
import type { Fact, SessionState } from '../../../plugin/core/model/types'
import { EVENT_LOG_LIMIT, REQUEST_LOG_LIMIT } from '../../../plugin/core/model/types'
import { payload, request, T0 } from './fixtures'

const MS = T0 * 1000

/** A snapshot fact received `offsetSec` after T0 with the given TTL. */
function snap(offsetSec: number, ttl: string | null): Fact {
  const cache = ttl === null ? { ttl: undefined } : { ttl }
  return { kind: 'snapshot', snapshot: parseSnapshot(payload({}, cache), MS + offsetSec * 1000) }
}

/** Runs facts through the reducer from the initial state. */
function run(facts: Fact[]): SessionState {
  return facts.reduce(reduce, initialState())
}

describe('reduce', () => {
  it('records exactly one TTL-change event when 1h turns into 5m (AC 1.3)', () => {
    const s = run([snap(0, '1h'), snap(10, '1h'), snap(20, '5m'), snap(30, '5m'), snap(40, '5m')])
    const changes = s.events.filter(e => e.kind === 'ttl_bucket_change')
    expect(changes).toEqual([{ ts: MS + 20000, kind: 'ttl_bucket_change', detail: { from: '1h', to: '5m' } }])
    expect(s.pending).toEqual(changes)
  })

  it('does not treat an unknown TTL as a change', () => {
    const s = run([snap(0, '1h'), snap(10, null), snap(20, '1h')])
    expect(s.events).toEqual([])
  })

  it('keeps the newest snapshot and ignores an older one', () => {
    const s = run([snap(20, '1h'), snap(10, '5m')])
    expect(s.lastSnapshot!.receivedAt).toBe(MS + 20000)
    expect(s.events).toEqual([])
  })

  it('settles events before a main request and keeps those during it', () => {
    const s = run([
      { kind: 'event', event: { ts: MS + 1000, kind: 'model_switch', detail: { from: 'claude-opus-5-5', to: 'claude-sonnet-5-5' } } },
      { kind: 'event', event: { ts: MS + 6000, kind: 'fast_toggle' } },
      { kind: 'request', request: request(MS + 5000) },
    ])
    expect(s.pending.map(e => e.kind)).toEqual(['fast_toggle'])
    expect(s.events).toHaveLength(2)
    expect(s.requests).toHaveLength(1)
    expect(s.lastTouch!.tsStart).toBe(MS + 5000)
  })

  it('bounds the main-lane request log', () => {
    const facts: Fact[] = Array.from({ length: REQUEST_LOG_LIMIT + 5 }, (_, i) => ({ kind: 'request', request: request(MS + i) }))
    const s = run(facts)
    expect(s.requests).toHaveLength(REQUEST_LOG_LIMIT)
    expect(s.requests[0]!.tsStart).toBe(MS + 5)
  })

  it('bounds the event log', () => {
    const facts: Fact[] = Array.from({ length: EVENT_LOG_LIMIT + 1 }, (_, i) => ({ kind: 'event', event: { ts: MS + i, kind: 'claude_md_edit' } }))
    expect(run(facts).events).toHaveLength(EVENT_LOG_LIMIT)
  })

  it('lets probes and keep-alives restart the TTL without joining the log or settling events', () => {
    const s = run([
      { kind: 'request', request: request(MS) },
      { kind: 'event', event: { ts: MS + 1000, kind: 'model_switch' } },
      { kind: 'request', request: request(MS + 2000, { lane: 'probe' }) },
      { kind: 'request', request: request(MS + 3000, { lane: 'keepalive' }) },
    ])
    expect(s.requests).toHaveLength(1)
    expect(s.lastTouch!.lane).toBe('keepalive')
    expect(s.pending).toHaveLength(1)
  })

  it('ignores subagent and compaction requests, and older touches', () => {
    const s = run([
      { kind: 'request', request: request(MS + 5000) },
      { kind: 'request', request: request(MS + 9000, { lane: 'subagent' }) },
      { kind: 'request', request: request(MS + 9000, { lane: 'compact' }) },
      { kind: 'request', request: request(MS + 1000, { lane: 'probe' }) },
    ])
    expect(s.requests).toHaveLength(1)
    expect(s.lastTouch!.tsStart).toBe(MS + 5000)
  })

  it('records resume information', () => {
    const resume = { ts: MS, source: 'resume' as const, secondsSinceLastResponse: 92, contextTokens: 126850, likelyExpired: false }
    expect(run([{ kind: 'resume', resume }]).resume).toEqual(resume)
  })

  it('never changes the state it was given', () => {
    const start = Object.freeze(initialState())
    const facts: Fact[] = [snap(0, '1h'), snap(5, '5m'), { kind: 'request', request: request(MS + 9000) }]
    expect(() => facts.reduce(reduce, start)).not.toThrow()
    expect(start).toEqual(initialState())
  })
})
