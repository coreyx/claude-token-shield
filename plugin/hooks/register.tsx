import type { Register } from 'claude-code'

import { CORE_VERSION } from '../core/version'

/**
 * Token Shield's hooks module: the only entry point the engine loads.
 *
 * This file only wires engine events to adapters, actions and UI (design.md,
 * "Repository layout"); the decisions themselves live in `../core/`. The
 * skeleton registers no hooks yet; later tasks add them here.
 */
export const register: Register = (_on, _options) => {
  // Referenced so the module proves at load time that a core import resolves
  // in the engine's module environment, not only under Vitest.
  void CORE_VERSION
}
