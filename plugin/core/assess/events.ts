/**
 * Looks events up in the invalidation table (`rules.json`, analysis §6.3).
 */

import type { Impact, RuleCondition, Rules } from '../data/types';
import { baseModelId } from '../model/ids';
import type { EventRecord } from '../model/types';
import type { AssessEnv } from './types';

/** The facts a rule's cases can test. */
export interface EventContext extends AssessEnv {
  /** The model the session runs on when the event happens. */
  readonly model?: string;
}

/**
 * The impact of an event here: the first matching case of its rule, else the
 * rule's default. An event kind the table doesn't know is `MAY`, so it makes
 * the state uncertain instead of being either ignored or alarmed on.
 *
 * @param event the event
 * @param rules the invalidation table
 * @param ctx the environment and current model
 */
export function eventImpact(event: EventRecord, rules: Rules, ctx: EventContext): Impact {
  const rule = rules.events.find(r => r.kind === event.kind);
  if (rule === undefined) return 'MAY';
  const facts = {
    perMessageEffort: ctx.model !== undefined && rules.perMessageEffortModels.includes(baseModelId(ctx.model)),
    toolSearch: ctx.toolSearch,
    experimentalBetasDisabled: ctx.experimentalBetasDisabled,
    provider: ctx.provider,
  };
  return rule.cases?.find(c => matches(c.when, facts))?.impact ?? rule.impact;
}

/** Whether every condition a case states holds. */
function matches(
  when: RuleCondition,
  facts: { perMessageEffort: boolean; toolSearch: boolean; experimentalBetasDisabled: boolean; provider: string },
): boolean {
  if (when.perMessageEffort !== undefined && when.perMessageEffort !== facts.perMessageEffort) return false;
  if (when.toolSearch !== undefined && when.toolSearch !== facts.toolSearch) return false;
  if (when.experimentalBetasDisabled !== undefined && when.experimentalBetasDisabled !== facts.experimentalBetasDisabled) return false;
  if (when.provider !== undefined && !(when.provider as readonly string[]).includes(facts.provider)) return false;
  return true;
}
