import type { Price } from "../domain/price.js";
import type { DexQuote, DexVenue } from "../marketdata/dex/types.js";

export type OpportunityKind = "reference_vs_onchain" | "cross_venue";

export type OpportunitySide = "buy_dex" | "sell_dex";

export interface CostBreakdown {
  notionalUsd: string;
  notionalUsdScaled: bigint;
  grossEdgeUsd: string;
  grossEdgeUsdScaled: bigint;
  grossEdgeBps: number;
  extraFeeUsd: string;
  extraFeeUsdScaled: bigint;
  extraFeeBps: number;
  slippageUsd: string;
  slippageUsdScaled: bigint;
  slippageBps: number;
  gasUsd: string;
  gasUsdScaled: bigint;
  gasSource: string;
  riskBufferUsd: string;
  riskBufferUsdScaled: bigint;
  riskBufferBps: number;
  netEdgeUsd: string;
  netEdgeUsdScaled: bigint;
  netEdgeBps: number;
}

export interface Opportunity {
  id: string;
  kind: OpportunityKind;
  symbol: string;
  side: OpportunitySide;
  buyVenue?: DexVenue | "reference";
  sellVenue?: DexVenue | "reference";
  token: string;
  multiplier: bigint;
  multiplierDecimal: string;
  sizeUsd: number;
  reference: Price;
  dex: Price;
  counterpart?: Price;
  costs: CostBreakdown;
  detectedAt: Date;
  expiresAt: Date;
  ttlMs: number;
  assetStatus: string;
  isTradingHalt: boolean;
}

export interface OpportunityRejection {
  symbol: string;
  kind?: OpportunityKind;
  reason: string;
  costs?: CostBreakdown;
  multiplier?: string;
  sizeUsd?: number;
}

export interface OpportunityScan {
  opportunities: Opportunity[];
  rejections: OpportunityRejection[];
}

export interface CostInputs {
  grossEdgeUsdScaled: bigint;
  notionalUsdScaled: bigint;
  extraFeeBps: number;
  slippageBps: number;
  gasUsdScaled: bigint;
  gasSource: string;
  riskBufferBps: number;
}
