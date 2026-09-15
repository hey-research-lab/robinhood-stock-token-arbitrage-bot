import type { AppConfig } from "../config/env.js";
import type { Opportunity } from "../opportunity/types.js";

export type RiskCode =
  | "ALLOWED"
  | "MISSING_OPPORTUNITY"
  | "KILL_SWITCH"
  | "MAX_DAILY_LOSS"
  | "MAX_SINGLE_TRADE"
  | "MAX_POSITION"
  | "MAX_SLIPPAGE"
  | "MIN_NET_EDGE_BPS"
  | "MIN_NET_EDGE_USD"
  | "OPPORTUNITY_EXPIRED"
  | "ASSET_INACTIVE"
  | "TRADING_HALT"
  | "MULTIPLIER_CHANGED";

export interface RiskBook {
  /** Signed USD exposure by symbol (buy increases, sell decreases). */
  positionsUsdBySymbol: Record<string, number>;
  /** Realized session PnL. Negative is a loss. */
  dailyPnlUsd: number;
  killSwitchTripped: boolean;
  killSwitchReason?: string;
  /** True after a Slack (or skip) attempt for the current trip. */
  killSwitchAlerted?: boolean;
  /** Set when the switch newly trips this process; side-effects flush it. */
  killSwitchNeedsAlert?: boolean;
}

export interface RiskContext {
  opportunity?: Opportunity;
  proposedNotionalUsd?: number;
  /** Re-read at execution time; if set and different from the quote, veto. */
  currentMultiplier?: bigint;
  currentAssetStatus?: string;
  currentHalt?: boolean;
  now?: number;
  book: RiskBook;
}

export interface RiskVerdict {
  allowed: boolean;
  code: RiskCode;
  reason: string;
  limits: AppConfig["risk"];
  symbol?: string;
  proposedNotionalUsd?: number;
  positionAfterUsd?: number;
  dailyPnlUsd?: number;
}

export function emptyRiskBook(): RiskBook {
  return {
    positionsUsdBySymbol: {},
    dailyPnlUsd: 0,
    killSwitchTripped: false,
  };
}
