import { ExecutionError } from "../domain/errors.js";
import type { TradeRecord } from "../domain/trade.js";
import { log } from "../logging/logger.js";
import { applyBps, formatScaled } from "../normalize/units.js";
import type { Opportunity } from "../opportunity/types.js";
import { recordFill } from "../risk/engine.js";
import type { RiskBook, RiskVerdict } from "../risk/types.js";
import { newTradeId, type TradeRegistry } from "./registry.js";

export function paperFillPriceScaled(opportunity: Opportunity): bigint {
  const slip = applyBps(opportunity.dex.valueUsdScaled, opportunity.costs.slippageBps);
  if (opportunity.side === "buy_dex") {
    return opportunity.dex.valueUsdScaled + slip;
  }
  const sold = opportunity.dex.valueUsdScaled - slip;
  if (sold <= 0n) {
    throw new ExecutionError("Paper fill price would be non-positive after slippage");
  }
  return sold;
}

export function signedNotionalUsd(opportunity: Opportunity): number {
  return opportunity.side === "buy_dex" ? opportunity.sizeUsd : -opportunity.sizeUsd;
}

function reconstructionFields(trade: TradeRecord): Record<string, unknown> {
  return {
    id: trade.id,
    opportunityId: trade.opportunityId,
    mode: trade.mode,
    state: trade.state,
    symbol: trade.symbol,
    side: trade.side,
    kind: trade.kind,
    token: trade.token,
    multiplier: trade.multiplier,
    sizeUsd: trade.sizeUsd,
    dexPriceUsd: trade.dexPriceUsd,
    fillPriceUsd: trade.fillPriceUsd,
    referencePriceUsd: trade.referencePriceUsd,
    extraFeeUsd: trade.extraFeeUsd,
    slippageUsd: trade.slippageUsd,
    slippageBps: trade.slippageBps,
    gasUsd: trade.gasUsd,
    gasSource: trade.gasSource,
    riskBufferUsd: trade.riskBufferUsd,
    grossEdgeUsd: trade.grossEdgeUsd,
    netEdgeUsd: trade.netEdgeUsd,
    realizedPnlUsd: trade.realizedPnlUsd,
    signedNotionalUsd: trade.signedNotionalUsd,
    riskCode: trade.riskCode,
    riskReason: trade.riskReason,
    txHash: trade.txHash ?? null,
  };
}

/**
 * Simulate a fill from the quoted executable, applying modeled fees, slippage,
 * and gas. Never sends a transaction.
 */
export function simulateFill(args: {
  opportunity: Opportunity;
  verdict: RiskVerdict;
  book: RiskBook;
  registry: TradeRegistry;
  now?: number;
}): TradeRecord {
  const now = args.now ?? Date.now();
  const at = new Date(now);
  const fillScaled = paperFillPriceScaled(args.opportunity);
  const realizedPnlUsd = args.opportunity.costs.netEdgeUsd;
  const signed = signedNotionalUsd(args.opportunity);
  const txHash = `paper:${args.opportunity.id}`;

  let trade: TradeRecord = {
    id: newTradeId("paper"),
    opportunityId: args.opportunity.id,
    symbol: args.opportunity.symbol,
    side: args.opportunity.side,
    kind: args.opportunity.kind,
    mode: "paper",
    state: "validated",
    detectedAt: args.opportunity.detectedAt,
    expiresAt: args.opportunity.expiresAt,
    token: args.opportunity.token,
    multiplier: args.opportunity.multiplierDecimal,
    sizeUsd: args.opportunity.sizeUsd,
    dexPriceUsd: args.opportunity.dex.valueUsd,
    fillPriceUsd: formatScaled(fillScaled),
    referencePriceUsd: args.opportunity.reference.valueUsd,
    extraFeeUsd: args.opportunity.costs.extraFeeUsd,
    slippageUsd: args.opportunity.costs.slippageUsd,
    slippageBps: args.opportunity.costs.slippageBps,
    gasUsd: args.opportunity.costs.gasUsd,
    gasSource: args.opportunity.costs.gasSource,
    riskBufferUsd: args.opportunity.costs.riskBufferUsd,
    grossEdgeUsd: args.opportunity.costs.grossEdgeUsd,
    netEdgeUsd: args.opportunity.costs.netEdgeUsd,
    realizedPnlUsd,
    signedNotionalUsd: signed,
    riskCode: args.verdict.code,
    riskReason: args.verdict.reason,
    fillRecorded: false,
    states: [{ state: "validated", at }],
  };

  args.registry.claim(trade);
  trade = args.registry.update(args.opportunity.id, { state: "quoted", at });
  trade = args.registry.update(args.opportunity.id, {
    state: "submitted",
    at,
    submittedAt: at,
    txHash,
  });
  trade = args.registry.update(args.opportunity.id, { state: "pending", at, pendingAt: at, txHash });

  recordFill(args.book, {
    symbol: args.opportunity.symbol,
    signedNotionalUsd: signed,
    realizedPnlUsd: Number(realizedPnlUsd),
  });

  trade = args.registry.update(args.opportunity.id, {
    state: "confirmed",
    at,
    confirmedAt: at,
    txHash,
    fillRecorded: true,
  });

  log.info("execution.state", reconstructionFields(trade));
  log.info("execution.paper_fill", reconstructionFields(trade));
  return trade;
}
