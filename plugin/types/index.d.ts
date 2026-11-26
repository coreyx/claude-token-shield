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

/** The last check rendered for the Token Shield pane. */
export type TokenShieldPane = {
  text: string
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

/** Contract version of the values below. */
export type TokenShieldContractVersion = 1

declare module 'claude-code' {
  interface PluginState {
    'token-shield': {
      status: TokenShieldStatus
      band: TokenShieldBand
      pane: TokenShieldPane
      levers: TokenShieldLevers
      armed: TokenShieldArmed
      setting: TokenShieldPendingSetting
    }
  }
}
