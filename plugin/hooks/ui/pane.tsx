import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import { formatString } from '../../core/data/load'
import { glyphParams, glyphSet } from '../../core/render/format'
import { renderPrefixMap } from '../../core/render/views/map'
import type { TokenShieldPane, TokenShieldPaneTab } from '../../types'
import { host } from '../host/host'
import { modelState } from '../session/model'

/** The pane: its tab and the last mid-turn check (design D7). */
const paneAtom = atom({ plugin: 'token-shield', key: 'pane' } as const, null as TokenShieldPane)

/** The pane's id. */
export const PANE_ID = 'token-shield'

/** The five views, in tab order; their hotkeys are 1 to 5. */
export const VIEWS: readonly TokenShieldPaneTab[] = ['map', 'runway', 'levers', 'context', 'history']

/** The catalog formatter with glyphs, or `null` before the host starts. */
function formatter() {
  const h = host()
  if (h === null || h.data === null) return null
  const g = glyphParams(glyphSet(h.config.glyphs))
  return (key: string, params: Record<string, string | number> = {}) => formatString(h.data!.strings, key, { ...g, ...params })
}

/**
 * `/cache-view [map|runway|levers|context|history]` (REQ-13): opens the
 * Token Shield pane on a view, the prefix map by default. The answer is
 * display-only and names where the view is.
 *
 * @param $ the engine interface
 * @param args the command's arguments
 */
export async function openView($: EngineInterface, args: string) {
  const t = formatter()
  const tab = (args.trim() || 'map') as TokenShieldPaneTab
  if (t === null) return { text: 'Token Shield: not started.', isTextDisplayOnly: true as const }
  if (!VIEWS.includes(tab)) return { text: t('view.usage'), isTextDisplayOnly: true as const }
  await showTab($, tab)
  await $.ui.open({ id: PANE_ID, title: t('pane.title') })
  return { text: t('view.opened', { view: t(`view.tab.${tab}`) }), isTextDisplayOnly: true as const }
}

/** Switches the pane to a tab, keeping the last mid-turn check. */
async function showTab($: EngineInterface, tab: TokenShieldPaneTab): Promise<void> {
  await update($, paneAtom, current => ({ tab, text: current?.text ?? null }))
}

/**
 * Draws the Token Shield pane: a tab row (pressable, with hotkeys 1 to 5,
 * and Check while a mid-turn check is held), then the tab's view at the
 * pane's width, all from the same data as /cache-check (REQ-13).
 *
 * @param $ the engine interface
 * @param e the Pane render request
 * @returns the pane's content, or `null` for another plugin's pane
 */
export async function drawPane($: EngineInterface, e: RenderInput<'Pane'>): Promise<RenderElement | null> {
  if (e.requestId !== PANE_ID) return null
  const pane = await read($, paneAtom)
  const tab = pane?.tab ?? 'map'
  const t = formatter()
  const { Box, Button, Text } = $.ui.resolve(e)
  if (t === null) return <Text>Token Shield: not started.</Text>
  const tabs = [...(pane?.text != null ? (['check'] as const) : []), ...VIEWS]
  const body = await viewText($, tab, pane?.text ?? null, Math.max(40, e.props.bodyColumns))
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" gap={1}>
        {tabs.map(id => {
          const hotkey = VIEWS.indexOf(id) + 1
          return (
            <Button
              key={`tab:${id}`}
              label={id === tab ? `[${t(`view.tab.${id}`)}]` : t(`view.tab.${id}`)}
              {...(hotkey > 0 ? { hotkey: String(hotkey) } : {})}
              onPress={() => showTab($, id)}
            />
          )
        })}
      </Box>
      {body.split('\n').map((line, i) => (
        <Text key={`l${i}`}>{line}</Text>
      ))}
    </Box>
  )
}

/** A tab's text at a width; views built later say so. */
async function viewText($: EngineInterface, tab: TokenShieldPaneTab, check: string | null, width: number): Promise<string> {
  const h = host()!
  const o = { glyphs: glyphSet(h.config.glyphs), strings: h.data!.strings, display: h.data!.rules.display, tzOffsetMin: h.tzOffsetMin }
  const s = modelState()
  switch (tab) {
    case 'check':
      return check ?? ''
    case 'map':
      return renderPrefixMap(s.requests, s.events, null, width, o, h.data!.prices)
    default:
      return formatString(o.strings, 'view.not_yet', { view: formatString(o.strings, `view.tab.${tab}`) })
  }
}
