/**
 * The session reducer: `(state, fact) → state`, pure and allocation-light, so
 * the same code runs in the mod, in tests, in the backtest and over stored
 * history (design.md, D1).
 */

import { valueOf } from './snapshot';
import type { EventRecord, Fact, NativeSnapshot, RequestRecord, SessionState } from './types';
import { EVENT_LOG_LIMIT, REQUEST_LOG_LIMIT } from './types';

/** The state of a session nothing has been observed in yet. */
export function initialState(): SessionState {
  return { lastSnapshot: null, requests: [], lastTouch: null, pending: [], events: [], resume: null };
}

/**
 * Feeds one fact into the session model and returns the new state; the input
 * state is never changed.
 *
 * @param state the current state
 * @param fact what was observed
 */
export function reduce(state: SessionState, fact: Fact): SessionState {
  switch (fact.kind) {
    case 'snapshot':
      return applySnapshot(state, fact.snapshot);
    case 'request':
      return applyRequest(state, fact.request);
    case 'event':
      return addEvent(state, fact.event);
    case 'resume':
      return { ...state, resume: fact.resume };
  }
}

/**
 * Keeps the newest snapshot and records a TTL change between consecutive
 * snapshots (REQ-1.0.3). A snapshot older than the one held is ignored, so a
 * late file read can't roll the state back.
 */
function applySnapshot(state: SessionState, snapshot: NativeSnapshot): SessionState {
  const previous = state.lastSnapshot;
  if (previous !== null && snapshot.receivedAt < previous.receivedAt) return state;
  const next = { ...state, lastSnapshot: snapshot };
  const from = previous?.promptCache ? valueOf(previous.promptCache.ttl) : undefined;
  const to = snapshot.promptCache ? valueOf(snapshot.promptCache.ttl) : undefined;
  // Only a change between two known TTLs is an event; an absent TTL on either side says nothing.
  const withTtl =
    from !== undefined && to !== undefined && from !== to ? addEvent(next, { ts: snapshot.receivedAt, kind: 'ttl_bucket_change', detail: { from, to } }) : next;
  // A miss Claude Code diagnosed since the last snapshot becomes a history event
  // with its first cause, so summaries can attribute the re-cache (REQ-14.0.2).
  const missAt = snapshot.promptCache ? valueOf(snapshot.promptCache.lastMissAt) : undefined;
  const seenAt = previous?.promptCache ? valueOf(previous.promptCache.lastMissAt) : undefined;
  const cause = snapshot.promptCache ? valueOf(snapshot.promptCache.lastMissCause)?.causes[0] : undefined;
  // Only a change between two snapshots: a first snapshot's miss predates the watch.
  // It describes a request already made, so it goes to the log, never to pending.
  if (previous !== null && missAt !== undefined && missAt !== seenAt && cause !== undefined) {
    return { ...withTtl, events: bounded([...withTtl.events, { ts: missAt, kind: 'native_miss', detail: { to: cause } }], EVENT_LOG_LIMIT) };
  }
  return withTtl;
}

/**
 * Records a request. A main-lane request joins the bounded log and settles
 * the events that happened before it started; events during it stay pending,
 * since they apply to the next request. Probes and keep-alives touch the main
 * prefix, so they restart its TTL; other lanes don't affect the main cache.
 */
function applyRequest(state: SessionState, request: RequestRecord): SessionState {
  if (request.lane === 'subagent' || request.lane === 'compact') return state;
  const lastTouch =
    state.lastTouch === null || request.tsStart >= state.lastTouch.tsStart ? request : state.lastTouch;
  if (request.lane !== 'main') return { ...state, lastTouch };
  return {
    ...state,
    lastTouch,
    requests: bounded([...state.requests, request], REQUEST_LOG_LIMIT),
    pending: state.pending.filter(e => e.ts > request.tsStart),
  };
}

/** Adds an event to the pending list and the bounded log. */
function addEvent(state: SessionState, event: EventRecord): SessionState {
  return {
    ...state,
    pending: [...state.pending, event],
    events: bounded([...state.events, event], EVENT_LOG_LIMIT),
  };
}

/** Keeps the newest `limit` entries. */
function bounded<T>(items: readonly T[], limit: number): readonly T[] {
  return items.length > limit ? items.slice(items.length - limit) : items;
}
