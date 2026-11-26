import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { formatString } from '../../core/data/load'
import { glyphParams, glyphSet } from '../../core/render/format'
import { applySetting, fingerprint, isAllowedSetting, pasteSnippet } from '../../core/settings/settings'
import type { SettingChange } from '../../core/settings/settings'
import type { TokenShieldBand, TokenShieldPendingSetting } from '../../types'
import { host } from '../host/host'

/** The change waiting for Confirm. */
const settingAtom = atom({ plugin: 'token-shield', key: 'setting' } as const, null as TokenShieldPendingSetting)
/** The band, set to confirm mode while a change waits. */
const bandAtom = atom({ plugin: 'token-shield', key: 'band' } as const, null as TokenShieldBand)

/**
 * The user settings file, where Claude Code reads `promptCacheTtl` and the
 * rest: under CLAUDE_CONFIG_DIR when set, else `~/.claude/settings.json`
 * (the same lookup as `tshield setup`). `display` is how the band names it,
 * without the person's home path.
 *
 * @param $ the engine interface
 */
export async function userSettingsFile($: EngineInterface): Promise<{ path: string; display: string } | null> {
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR'))?.trim()
  if (configDir) return { path: `${configDir}/settings.json`, display: '$CLAUDE_CONFIG_DIR/settings.json' }
  const machine = await $.session.machine()
  // Windows has USERPROFILE and usually no HOME; elsewhere HOME is the home folder.
  const home = machine.sysname.startsWith('Windows') ? await $.env.get('USERPROFILE') : await $.env.get('HOME')
  if (!home) return null
  return { path: `${home}/.claude/settings.json`, display: '~/.claude/settings.json' }
}

/** Reads a file's text, or `null` when it doesn't exist or can't be read. */
async function readText($: EngineInterface, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path)
  } catch {
    return null
  }
}

/** The catalog, the glyphs and the string formatter, or `null` before the host starts. */
function strings() {
  const h = host()
  if (h === null || h.data === null) return null
  const s = h.data.strings
  const g = glyphParams(glyphSet(h.config.glyphs))
  return (key: string, params: Record<string, string> = {}) => formatString(s, key, { ...g, ...params })
}

/**
 * Shows a settings change in the band's confirm mode (REQ-5.0.2): the key,
 * the file it goes in and the value. Nothing is written until Confirm.
 *
 * @param $ the engine interface
 * @param change the key and value
 * @returns the line the caller answers with
 */
export async function offerSetting($: EngineInterface, change: SettingChange): Promise<string> {
  const t = strings()
  if (t === null) return 'Token Shield: not started.'
  const file = await userSettingsFile($)
  const value = JSON.stringify(change.value)
  if (!isAllowedSetting(change) || file === null) {
    return t('setting.paste', { file: '~/.claude/settings.json', reason: file === null ? 'no home folder' : 'not a setting Token Shield changes', snippet: pasteSnippet(change) })
  }
  const text = t('setting.confirm', { key: change.key, value, file: file.display })
  const shown = await readText($, file.path)
  await update($, settingAtom, () => ({ key: change.key, value: change.value, path: file.path, display: file.display, fingerprint: fingerprint(shown) }))
  await update($, bandAtom, () => ({ mode: 'confirm' as const, text, lever: 'setting' }))
  return text
}

/**
 * Writes the confirmed change: through `$.config.set` when `/config` has a
 * row for the key, otherwise into the user settings file, but only if the
 * file is as it was shown. A refused or failed write shows the JSON to paste
 * and changes nothing (REQ-5.0.5).
 *
 * @param $ the engine interface
 */
export async function confirmSetting($: EngineInterface): Promise<void> {
  const pending = await read($, settingAtom)
  await update($, settingAtom, () => null)
  await update($, bandAtom, () => null)
  const t = strings()
  if (pending === null || t === null) return
  const change = { key: pending.key, value: pending.value }
  const value = JSON.stringify(pending.value)
  const paste = (reason: string) => $.ui.toast(t('setting.paste', { file: pending.display, reason, snippet: pasteSnippet(change) }))

  const rows = await $.config.list().catch(() => [])
  if (rows.some(row => row.key === pending.key)) {
    const r = await $.config.set({ key: pending.key, value: pending.value }).catch((err: unknown) => ({ deny: err instanceof Error ? err.message : 'refused' }))
    if (r.deny !== undefined) paste(r.deny)
    else $.ui.toast(t('setting.done', { key: pending.key, value, file: '/config' }))
    return
  }

  const now = await readText($, pending.path)
  if (fingerprint(now) !== pending.fingerprint) {
    $.ui.toast(t('setting.changed', { file: pending.display }))
    return
  }
  const merged = applySetting(now, change)
  if (!merged.ok) {
    paste(merged.reason === 'unparseable' ? "it isn't plain JSON" : "it isn't a JSON object")
    return
  }
  try {
    await $.fs.write(pending.path, merged.text)
    $.ui.toast(t('setting.done', { key: pending.key, value, file: pending.display }))
  } catch (err) {
    paste(err instanceof Error ? err.message : 'the write was refused')
  }
}

/**
 * Drops a change waiting for Confirm.
 *
 * @param $ the engine interface
 * @returns whether one was waiting
 */
export async function cancelSetting($: EngineInterface): Promise<boolean> {
  const pending = await read($, settingAtom)
  await update($, settingAtom, () => null)
  return pending !== null
}
