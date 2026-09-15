/**
 * Explicit trade lifecycle. Persisted in SQLite so a crash cannot double-execute.
 */
export type TradeState =
  | "detected"
  | "validated"
  | "quoted"
  | "submitted"
  | "pending"
  | "confirmed"
  | "failed"
  | "reconciled";

export type ExecutionMode = "paper" | "live";

export interface TradeStateChange {
  state: TradeState;
  at: Date;
}

export interface TradeRecord {
  id: string;
  opportunityId: string;
  symbol: string;
  side: "buy_dex" | "sell_dex";
  kind: "reference_vs_onchain" | "cross_venue";
  mode: ExecutionMode;
  state: TradeState;
  detectedAt: Date;
  expiresAt: Date;
  submittedAt?: Date;
  pendingAt?: Date;
  confirmedAt?: Date;
  failedAt?: Date;
  txHash?: string;
  token: string;
  multiplier: string;
  sizeUsd: number;
  dexPriceUsd: string;
  fillPriceUsd: string;
  referencePriceUsd: string;
  extraFeeUsd: string;
  slippageUsd: string;
  slippageBps: number;
  gasUsd: string;
  gasSource: string;
  riskBufferUsd: string;
  grossEdgeUsd: string;
  netEdgeUsd: string;
  realizedPnlUsd: string;
  signedNotionalUsd: number;
  riskCode: string;
  riskReason: string;
  failureReason?: string;
  fillRecorded: boolean;
  reconciledAt?: Date;
  states: TradeStateChange[];
}
