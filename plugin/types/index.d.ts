/**
 * Token Shield's `$.state` contract: the values its hooks keep in the
 * session's state and its drawings read. Each value is plain JSON, so it
 * survives a reload of the module.
 */

/** The cache states, as the status segment and band show them. */
export type TokenShieldState = 'HOT' | 'EXPIRING' | 'UNCERTAIN' | 'INVALIDATED' | 'COLD' | 'UNKNOWN'

/** The latest assessment, as the band and panes need it. */
export type TokenShieldStatus = {
  state: TokenShieldState
  /** The rendered status segment. */
  segment: string
  /** When it was assessed, epoch ms. */
  at: number
} | null

/** What the above-prompt band shows, if anything (design D8, D13). */
export type TokenShieldBand = {
  mode: 'state' | 'guard' | 'resume' | 'confirm' | 'gate' | 'keepalive'
  /** The band's text, already rendered from the catalog. */
  text: string
  /** The recommended lever's id, or in confirm mode the action Confirm runs. */
  lever: string | null
  /** Buttons the band offers beside its text, by action id. */
  actions?: string[]
} | null

/** The Token Shield pane's tabs: the five views, and a mid-turn /cache-check. */
export type TokenShieldPaneTab = 'check' | 'map' | 'runway' | 'levers' | 'context' | 'history'

/** The Token Shield pane: the tab shown, and the last mid-turn check, if any. */
export type TokenShieldPane = {
  tab: TokenShieldPaneTab
  /** The last check rendered while a turn ran, for the Check tab. */
  text: string | null
} | null

/** The command levers the last /cache-check found applicable, in its order. */
export type TokenShieldLevers = string[]

/** Armed clear controls: each instance's id and when it was armed, epoch ms (design D11). */
export type TokenShieldArmed = Record<string, number>

/** A settings change shown in the band and waiting for Confirm (design D11). */
export type TokenShieldPendingSetting = {
  key: string
  value: string | boolean | number
  /** The settings file's path, and how the band names it. */
  path: string
  display: string
  /** The file's fingerprint when it was shown. */
  fingerprint: string
} | null

/** The context breakdown's categories, fetched for the Context view and the prefix map's layers. */
export type TokenShieldContext = { name: string; tokens: number; kind: string }[] | null

/** A counter bumped to redraw the runway while it is shown. */
export type TokenShieldTick = number

/**
 * The history dashboard's data, gathered off the render path when its tab
 * opens: plain JSON holding the core's history summary, advice report,
 * calibration and TTL advice. Opaque here because a contract can't import
 * the core's types; the pane, its one writer and reader, knows the shapes.
 */
export type TokenShieldDashboard = {
  summary: unknown
  advice: unknown
  calibration: unknown
  ttl: unknown
} | null

/** Contract version of the values below. */
export type TokenShieldContractVersion = 1

declare module 'claude-code' {
  interface PluginState {
    'token-shield': {
      status: TokenShieldStatus
      band: TokenShieldBand
      pane: TokenShieldPane
      context: TokenShieldContext
      tick: TokenShieldTick
      dashboard: TokenShieldDashboard
      levers: TokenShieldLevers
      armed: TokenShieldArmed
      setting: TokenShieldPendingSetting
    }
  }
}
