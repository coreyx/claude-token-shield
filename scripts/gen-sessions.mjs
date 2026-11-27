#!/usr/bin/env node
/**
 * Writes the backtest's synthetic sessions to fixtures/sessions/ (design
 * "Testing approach": the backtest replays them through the assessor).
 *
 * Each session is a run of main requests on one TTL, each followed by the
 * bridge's snapshot as Claude Code would report it: warm until one TTL after
 * the request. Idle gaps are drawn from a mix that resembles real use (mostly
 * short, some within the hour, some longer), and a small share of requests
 * miss inside the TTL, as a server-side eviction would, so the backtest has
 * real errors to measure. A fixed seed keeps the files the same on every run.
 *
 * Usage: node scripts/gen-sessions.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const dir = fileURLToPath(new URL('../fixtures/sessions/', import.meta.url))

/** A small deterministic PRNG (mulberry32), so the fixtures never change unasked. */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const TTL_SEC = { '5m': 300, '1h': 3600 }

/** An idle gap in seconds: mostly a minute or two, sometimes longer than the TTL. */
function gap(r, ttl) {
  const u = r()
  if (u < 0.55) return 20 + Math.round(r() * 160)
  if (u < 0.85) return Math.round(TTL_SEC[ttl] * (0.3 + r() * 0.6))
  if (u < 0.93) return Math.round(TTL_SEC[ttl] * (0.95 + r() * 0.1))
  return Math.round(TTL_SEC[ttl] * (1.2 + r() * 2))
}

/** One synthetic session's facts, in time order. */
function session(name, seed, ttl, requests, start) {
  const r = rng(seed)
  const id = `${String(seed).padStart(8, '0')}-0000-4000-8000-${String(seed).padStart(12, '0')}`
  const facts = []
  let ts = start
  let prefix = 40_000
  let expires = null
  for (let i = 0; i < requests; i++) {
    if (i > 0) {
      ts += gap(r, ttl) * 1000
      // The statusline refreshes every 30 s, so a snapshot from just before the
      // request reports the cache as Claude Code then saw it.
      const refreshAt = ts - 10_000
      const warmThen = refreshAt < expires
      facts.push({
        kind: 'snapshot',
        receivedAt: refreshAt,
        payload: {
          session_id: id,
          model: { id: 'claude-opus-5-5' },
          version: '2.1.332',
          prompt_cache: { warm: warmThen, caching_observed: true, ttl, expires_at: warmThen ? Math.floor(expires / 1000) : null, recache_tokens_if_cold: prefix },
        },
      })
    }
    const expired = expires !== null && ts >= expires
    // A rare miss inside the TTL, as a server-side eviction would cause.
    const evicted = !expired && i > 0 && r() < 0.02
    const read = i === 0 || expired || evicted ? 0 : prefix
    const added = 1_500 + Math.round(r() * 6_000)
    const write = read === 0 ? prefix + added : added
    const usage = { input: 10, read, write5m: ttl === '5m' ? write : 0, write1h: ttl === '1h' ? write : 0, output: 300 + Math.round(r() * 900) }
    facts.push({
      kind: 'request',
      request: { id: `${name}-${i}`, lane: 'main', tsStart: ts, tsStartTier: 'measured', durationMs: 4_000, model: 'claude-opus-5-5', speed: 'standard', ttl, usage, source: 'mod' },
    })
    prefix = read + write + usage.output
    expires = ts + TTL_SEC[ttl] * 1000
    const receivedAt = ts + 5_000
    facts.push({
      kind: 'snapshot',
      receivedAt,
      payload: {
        session_id: id,
        model: { id: 'claude-opus-5-5' },
        version: '2.1.332',
        prompt_cache: { warm: true, caching_observed: true, ttl, expires_at: Math.floor(expires / 1000), recache_tokens_if_cold: prefix },
      },
    })
  }
  return { name, ttl, facts }
}

const BASE = Date.UTC(2026, 0, 5, 9, 0)
const sessions = [
  session('long-day-1h', 101, '1h', 120, BASE),
  session('short-day-1h', 102, '1h', 40, BASE + 86_400_000),
  session('steady-1h', 103, '1h', 80, BASE + 2 * 86_400_000),
  session('steady-5m', 104, '5m', 90, BASE + 3 * 86_400_000),
  session('bursty-5m', 105, '5m', 60, BASE + 4 * 86_400_000),
]

mkdirSync(dir, { recursive: true })
for (const s of sessions) writeFileSync(`${dir}${s.name}.json`, `${JSON.stringify(s, null, 1)}\n`)
console.log(`wrote ${sessions.length} sessions to fixtures/sessions/`)
