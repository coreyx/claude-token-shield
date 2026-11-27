#!/usr/bin/env node
/**
 * Totals the input tokens of one Claude Code session transcript, for the
 * live privacy check (TASK-36): run it on the same scripted session with
 * Token Shield enabled and disabled and compare. Reads numbers only (usage
 * fields of assistant lines, each response counted once) and prints one
 * line; no text from the transcript is printed.
 *
 * Usage: node scripts/sum-transcript.mjs <transcript.jsonl>
 */

import { readFileSync } from 'node:fs'

const file = process.argv[2]
if (file === undefined) {
  console.error('usage: node scripts/sum-transcript.mjs <transcript.jsonl>')
  process.exit(2)
}
const seen = new Set()
const total = { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (line.trim() === '') continue
  let entry
  try {
    entry = JSON.parse(line)
  } catch {
    continue
  }
  const usage = entry?.message?.usage
  if (entry?.type !== 'assistant' || usage === undefined) continue
  // A streamed response repeats its usage on several lines; count it once.
  const id = entry.requestId ?? entry.message.id
  if (id === undefined || seen.has(id)) continue
  seen.add(id)
  total.requests += 1
  total.input += usage.input_tokens ?? 0
  total.cacheRead += usage.cache_read_input_tokens ?? 0
  total.cacheWrite += usage.cache_creation_input_tokens ?? 0
  total.output += usage.output_tokens ?? 0
}
const allInput = total.input + total.cacheRead + total.cacheWrite
console.log(`requests ${total.requests} · total input ${allInput} (uncached ${total.input}, cache read ${total.cacheRead}, cache write ${total.cacheWrite}) · output ${total.output}`)
