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
  mode: 'state' | 'guard' | 'resume' | 'confirm' | 'gate'
  /** The band's text, already rendered from the catalog. */
  text: string
  /** The recommended lever's id, when the band offers one. */
  lever: string | null
} | null

/** The last check rendered for the Token Shield pane. */
export type TokenShieldPane = {
  text: string
} | null

/** The command levers the last /cache-check found applicable, in its order. */
export type TokenShieldLevers = string[]

/** Contract version of the values below. */
export type TokenShieldContractVersion = 1

declare module 'claude-code' {
  interface PluginState {
    'token-shield': {
      status: TokenShieldStatus
      band: TokenShieldBand
      pane: TokenShieldPane
      levers: TokenShieldLevers
    }
  }
}
