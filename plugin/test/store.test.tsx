import { expect, test } from 'claude-code/testing'

import { engine, SESSION, START, T0 } from './engine'

const DATA = '/home/example/.token-shield'
const BAND = { plugin: 'token-shield', component: 'AbovePrompt', requestId: 'band', surface: 'terminal', props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} } } as const
const check = (args: string) => ({ command: 'cache-check', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } })
const isTshield = (argv: readonly string[], cmd: string) => argv[0]!.includes('/bin/linux-amd64/tshield') && argv[1] === cmd

test('history older than historyDays is pruned through tshield at session start', async ($, on) => {
  const seen = engine(on, { binary: true })
  await $.session.start(START)
  for (let i = 0; i < 3; i++) await seen.clock.advance(1)
  expect(seen.runs.some(r => isTshield(r, 'prune'))).toBe(true)
})

test('/cache-check forget asks first, then deletes through tshield forget --yes (AC 14.6)', async ($, on) => {
  const seen = engine(on, { binary: true })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>beneath</Text>
  })
  await $.session.start(START)
  const { text } = await $.command.run(check('forget'))
  expect(text).toBe("Token Shield · delete all stored history, snapshots and backfill? This can't be undone.")
  expect(seen.runs.some(r => isTshield(r, 'forget'))).toBe(false)
  const band = await $.ui.mount(BAND)
  await band.press({ key: 'cancel' })
  expect(seen.toasts).toContain('Token Shield: nothing was deleted.')
  await $.command.run(check('forget'))
  await band.press({ key: 'confirm' })
  expect(seen.runs.find(r => isTshield(r, 'forget'))).toEqual([expect.stringContaining('tshield'), 'forget', '--yes'])
  expect(seen.toasts).toContain('Token Shield: all stored history, snapshots and backfill are deleted.')
  await band.unmount()
})

test('without the tshield binary, forget says it needs it and names the path it tried', async ($, on) => {
  engine(on)
  await $.session.start(START)
  expect((await $.command.run(check('forget'))).text).toMatch(
    /^Token Shield: deleting history needs the tshield binary, and \S*\/bin\/linux-amd64\/tshield isn't there: rebuild it or reinstall Token Shield, then restart Claude Code\.$/,
  )
})

test('after setup, the backfill is offered once and runs only on Confirm (design D17)', async ($, on) => {
  const seen = engine(on, { binary: true })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>beneath</Text>
  })
  await $.session.start(START)
  const band = await $.ui.mount(BAND)
  await $.command.run(check('setup'))
  await band.press({ key: 'confirm' })
  expect((await band.find({ type: 'Text', text: /read your earlier Claude Code transcripts/ }))?.text).toMatch(/^Token Shield · read your earlier/)
  expect(seen.runs.some(r => isTshield(r, 'backfill'))).toBe(false)
  await band.press({ key: 'confirm' })
  expect(seen.runs.some(r => isTshield(r, 'backfill'))).toBe(true)
  expect(seen.toasts).toContain('Token Shield: read 2 transcripts: 14 requests from 2 sessions; 0 lines unreadable (100.0% coverage).')
  // Set up again: no second offer.
  await $.command.run(check('setup'))
  await band.press({ key: 'confirm' })
  expect(await band.find({ type: 'Text', text: /read your earlier Claude Code transcripts/ })).toBeUndefined()
  await band.unmount()
})

test('the history view shows the baseline from backfilled transcripts beside the figure since (REQ-14.0.8)', async ($, on) => {
  const seen = engine(on, { binary: true })
  const req = (ts: number, read: number, write: number, source: string) => ({
    type: 'request',
    request: { id: `r${ts}`, lane: 'main', tsStart: ts, tsStartTier: 'measured', model: 'claude-opus-5-5', speed: 'standard', ttl: '1h', usage: { input: 10, read, write5m: 0, write1h: write, output: 500 }, source },
  })
  const DAY = 86_400_000
  const MIN = 60_000
  seen.files.set(`${DATA}/backfill/old-session/000000.json`, {
    text: JSON.stringify({ v: 1, session_id: 'old-session', seq: 0, records: [req(T0 - 40 * DAY, 0, 800_000, 'transcript'), req(T0 - 40 * DAY + 70 * MIN, 0, 800_000, 'transcript')] }),
    mtimeMs: T0,
  })
  seen.files.set(`${DATA}/history/${SESSION}/000000.json`, {
    text: JSON.stringify({ v: 1, session_id: SESSION, seq: 0, records: [req(T0 - 2 * DAY, 802_500, 2_000, 'mod'), req(T0 - 2 * DAY + 70 * MIN, 0, 802_500, 'mod')] }),
    mtimeMs: T0,
  })
  await $.session.start(START)
  const { text } = await $.command.run(check('history'))
  expect(text).toMatch(/\nBaseline        \$\d+\.\d\d\/week avoidable before Token Shield \(\d+ weeks of transcripts\), \$\d+\.\d\d\/week since/)
})
