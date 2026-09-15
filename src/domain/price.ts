import { PRICE_UNIT } from "../config/constants.js";
import { StalePriceError } from "./errors.js";

export type PriceSource =
  | "rest_reference"
  | "chainlink"
  | "dex_uniswap"
  | "dex_uniswap_stub"
  | "dex_arcus"
  | "dex_pleiades"
  | "onchain_multiplier";

export type PriceSide = "mid" | "bid" | "ask" | "executable_buy" | "executable_sell";

export interface Price {
  symbol: string;
  source: PriceSource;
  timestamp: Date;
  /** ERC-8056 uiMultiplier used to normalize this price, 1e18-scaled. */
  multiplier: bigint;
  unit: typeof PRICE_UNIT;
  side: PriceSide;
  /** USD per 1 raw ERC-20 token, 1e18-scaled. */
  valueUsdScaled: bigint;
  /** Human-readable USD per raw token. */
  valueUsd: string;
  meta?: Record<string, unknown>;
}

export function assertFresh(price: Price, maxAgeMs: number, now = Date.now()): void {
  const ageMs = now - price.timestamp.getTime();
  if (ageMs > maxAgeMs) {
    throw new StalePriceError(price.source, ageMs, maxAgeMs);
  }
}

export function isFresh(price: Price, maxAgeMs: number, now = Date.now()): boolean {
  return now - price.timestamp.getTime() <= maxAgeMs;
}
