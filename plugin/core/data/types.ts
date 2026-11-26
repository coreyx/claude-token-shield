/**
 * Shapes of the three shared data files in `plugin/data/`. The Go companions
 * read the same files through `internal/data`, so a field added here is added
 * there too, and the JSON Schemas under `schemas/` are the contract both meet.
 */

/** Rates for one model, in USD per million tokens (`input`) and multiples of it. */
export interface ModelPrice {
  /** Base input price. */
  readonly input: number;
  /** Cache read price as a multiple of `input`. */
  readonly read_mult: number;
  /** 5-minute cache write price as a multiple of `input`. */
  readonly write_5m_mult: number;
  /** 1-hour cache write price as a multiple of `input`. */
  readonly write_1h_mult: number;
  /** Base input price in fast mode, when the model offers it. */
  readonly fast_input?: number;
  /**
   * Prompt-size tiers: a request whose whole prompt is above `above` tokens
   * is priced at that tier's `input` for every token (Haiku 5.5).
   */
  readonly tiers?: readonly PriceTier[];
}

/** One prompt-size tier of a model's price. */
export interface PriceTier {
  /** The tier applies to prompts strictly larger than this many tokens. */
  readonly above: number;
  /** Base input price within the tier. */
  readonly input: number;
}

/** How a provider's prices relate to Anthropic's list prices. */
export interface ProviderPrice {
  /** Multiplier over list price on the provider's default (global) endpoint. */
  readonly multiplier: number;
  /** Multiplier on regional endpoints, where the provider has them. */
  readonly regional_multiplier?: number;
  /** Multiplier for data-zone deployments (Microsoft Foundry). */
  readonly data_zone_multiplier?: number;
  /** `list` when the rates are published list prices, `estimated` when the provider prices independently. */
  readonly basis: 'list' | 'estimated';
}

/** One dated price table. */
export interface PriceTable {
  /** First day the table applies, `YYYY-MM-DD`. */
  readonly effective: string;
  /** Where the figures came from. */
  readonly source?: string;
  /** Prices by model id. */
  readonly models: Readonly<Record<string, ModelPrice>>;
  /** Provider adjustments by provider key. */
  readonly providers: Readonly<Record<string, ProviderPrice>>;
}

/** `prices.json`: every price table, kept by date. */
export interface Prices {
  readonly v: number;
  readonly unit: 'USD per million tokens';
  readonly tables: readonly PriceTable[];
}

/** Whether an event invalidates the cache: always, possibly, or never. */
export type Impact = 'WILL' | 'MAY' | 'NO_EFFECT';

/** Provider keys used by the invalidation table and the price table. */
export type ProviderKey = 'firstParty' | 'claudePlatformAws' | 'bedrock' | 'vertex' | 'foundry' | 'gateway';

/** Conditions under which an event's impact differs from its default. All given keys must match. */
export interface RuleCondition {
  readonly perMessageEffort?: boolean;
  readonly toolSearch?: boolean;
  readonly experimentalBetasDisabled?: boolean;
  readonly provider?: readonly ProviderKey[];
}

/** One row of the invalidation table. The first matching case wins; otherwise `impact` applies. */
export interface EventRule {
  readonly kind: string;
  readonly impact: Impact;
  readonly basis: 'documented' | 'learned';
  /** Compaction: a rebuild the user chose, reported as "expected rebuild", not a miss. */
  readonly expectedRebuild?: boolean;
  readonly note?: string;
  readonly cases?: readonly { readonly when: RuleCondition; readonly impact: Impact }[];
}

/** `rules.json`: the parts of the assessment algorithm that are data. */
export interface Rules {
  readonly v: number;
  /** Below this Claude Code version, cache features are off (REQ-1). */
  readonly minClaudeCodeVersion: string;
  /** Models that keep the cache across effort changes. */
  readonly perMessageEffortModels: readonly string[];
  readonly events: readonly EventRule[];
  /** Default warn windows per TTL, in seconds. */
  readonly warnWindowsSec: { readonly '1h': number; readonly '5m': number };
  readonly timing: {
    readonly skewSec: number;
    readonly baseMarginSec: number;
    readonly nativeTimeErrSec: number;
    readonly staleSnapshotSec: number;
    readonly heartbeatFreshSec: number;
  };
  readonly priors: {
    readonly epsWithin: number;
    readonly epsAfter: number;
    readonly mayEvent: { readonly alpha: number; readonly beta: number };
    readonly minCalibrationN: number;
  };
  /** Display caps: never show above `maxProb` or below `minProb`. */
  readonly display: { readonly maxProb: number; readonly minProb: number };
}

/** Whether a string speaks about a future request; AC 2.8 checks `future` strings. */
export type Tense = 'future' | 'past' | 'none';

/** One catalog entry. */
export interface CatalogString {
  readonly text: string;
  readonly tense: Tense;
}

/** `strings.en.json`: every user-facing string by key. */
export interface Strings {
  readonly v: number;
  readonly locale: string;
  readonly strings: Readonly<Record<string, CatalogString>>;
}

/** The three files together, as the core receives them. */
export interface SharedData {
  readonly prices: Prices;
  readonly rules: Rules;
  readonly strings: Strings;
}
