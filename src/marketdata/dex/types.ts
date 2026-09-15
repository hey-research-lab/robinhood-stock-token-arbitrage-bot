import type { Address } from "viem";
import type { Price } from "../../domain/price.js";

export type DexVenue = "uniswap" | "arcus" | "pleiades";

export interface DexQuoteRequest {
  symbol: string;
  token: Address;
  quoteToken: Address;
  quoteTokenSymbol: string;
  quoteTokenDecimals: number;
  tokenDecimals: number;
  /** Notional in USD that the quote should be size-aware for. */
  sizeUsd: number;
  multiplier: bigint;
  side: "buy_token" | "sell_token";
  /** Required to convert USD size into token units on sells. */
  referenceTokenUsdScaled?: bigint;
  swapper?: Address;
}

export interface DexQuote {
  venue: DexVenue;
  stub: boolean;
  request: DexQuoteRequest;
  executable: Price;
  feeBps?: number;
  estimatedSlippageBps?: number;
  estimatedGasUsd?: string;
  gasSource?: "uniswap_quote" | "uniswapx_gasless" | "config_fallback" | "stub";
  routing?: string;
  inputAmount?: string;
  outputAmount?: string;
  /** Full Trading API quote body, used to build POST /swap. Absent on stubs. */
  rawQuote?: Record<string, unknown>;
  note?: string;
}

export interface DexAdapter {
  venue: DexVenue;
  quote(request: DexQuoteRequest): Promise<DexQuote>;
}
