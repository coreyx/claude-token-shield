/**
 * Token Shield's `$.state` contract.
 *
 * Every value the mod keeps in `$.state` is declared here, under
 * `interface PluginState`, so `claude plugin validate` can hold the module to
 * it. The skeleton keeps no state yet; TASK-17 adds the session model's atoms.
 */

/**
 * Version of this contract. Raised when a stored `$.state` value changes
 * shape, so a reloaded module can recognise values an earlier version kept.
 */
export type TokenShieldContractVersion = 1
