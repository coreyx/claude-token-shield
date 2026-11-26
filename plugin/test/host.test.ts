import { expect, test } from 'claude-code/testing'

import { engine, prompt, START } from './engine'

test('an invalid threshold is named in a toast and the default applies (AC 22.2)', { options: { thresholdUsd: -1 } }, async ($, on) => {
  const seen = engine(on)
  await $.session.start(START)
  expect(seen.toasts.some(t => t.includes('thresholdUsd') && t.includes('(2)'))).toBe(true)
  const mirrored = JSON.parse(seen.files.get('/plugin-data/config.json')?.text ?? '{}')
  expect(mirrored.thresholdUsd).toBe(2)
})

test('below v2.1.260 cache features are off and the message names the version (AC 1.4)', async ($, on) => {
  const seen = engine(on, { version: '2.1.259' })
  await $.session.start(START)
  expect(seen.toasts.some(t => t.includes('v2.1.260'))).toBe(true)
})

test('a failing assessor leaves prompts submitting and logs once (AC 21.3)', async ($, on) => {
  const seen = engine(on, { rules: '{' })
  await $.session.start(START)
  for (const text of ['first', 'second', 'third']) {
    const result = await $.prompt.submit(prompt(text))
    expect(result).toEqual({ text })
  }
  const submitFailures = seen.logs.filter(l => l.to === 'debug' && l.text.includes('prompt.submit failed'))
  expect(submitFailures.length).toBe(1)
})

test('without a binary the mod keeps its data in the plugin folder', async ($, on) => {
  const seen = engine(on)
  await $.session.start(START)
  expect(seen.files.has('/plugin-data/config.json')).toBe(true)
})

test('with a binary the mod uses its data directory and installs a newer version', async ($, on) => {
  const seen = engine(on, { binary: true })
  await $.session.start(START)
  expect(seen.files.has('/home/example/.token-shield/config.json')).toBe(true)
  expect(seen.runs.some(r => r[1] === 'self-install')).toBe(true)
})
