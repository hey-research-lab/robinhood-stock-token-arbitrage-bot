import type { AppConfig } from "../config/env.js";
import { log } from "../logging/logger.js";
import { isOpportunityExpired } from "../opportunity/engine.js";
import type { RiskBook, RiskCode, RiskContext, RiskVerdict } from "./types.js";
import { emptyRiskBook } from "./types.js";

export type { RiskBook, RiskCode, RiskContext, RiskVerdict } from "./types.js";
export { emptyRiskBook } from "./types.js";

function verdict(
  config: AppConfig,
  args: Omit<RiskVerdict, "limits" | "allowed"> & { allowed?: boolean },
): RiskVerdict {
  const result: RiskVerdict = {
    allowed: args.allowed ?? args.code === "ALLOWED",
    code: args.code,
    reason: args.reason,
    limits: config.risk,
    symbol: args.symbol,
    proposedNotionalUsd: args.proposedNotionalUsd,
    positionAfterUsd: args.positionAfterUsd,
    dailyPnlUsd: args.dailyPnlUsd,
  };
  const payload = {
    allowed: result.allowed,
    code: result.code,
    reason: result.reason,
    symbol: result.symbol ?? null,
    proposedNotionalUsd: result.proposedNotionalUsd ?? null,
    positionAfterUsd: result.positionAfterUsd ?? null,
    dailyPnlUsd: result.dailyPnlUsd ?? null,
    maxPositionPerSymbolUsd: result.limits.maxPositionPerSymbolUsd,
    maxSingleTradeUsd: result.limits.maxSingleTradeUsd,
    maxDailyLossUsd: result.limits.maxDailyLossUsd,
    minNetEdgeBps: result.limits.minNetEdgeBps,
    maxSlippageBps: result.limits.maxSlippageBps,
  };
  if (result.code === "KILL_SWITCH" || result.code === "MAX_DAILY_LOSS") {
    log.error("risk.kill_switch", payload);
  } else {
    log.info("risk.verdict", payload);
  }
  return result;
}

function armKillSwitch(book: RiskBook, reason: string): void {
  const already = book.killSwitchTripped;
  book.killSwitchTripped = true;
  book.killSwitchReason = reason;
  if (!already && !book.killSwitchAlerted) {
    book.killSwitchNeedsAlert = true;
  }
}

/**
 * Hard gate between signal and execution. The execution engine must call this
 * and must not submit when `allowed` is false. Kill-switch trips persist on
 * the book until `resetKillSwitch` — recovering PnL does not auto-reset.
 */
export function evaluateRisk(config: AppConfig, context: RiskContext): RiskVerdict {
  const book = context.book ?? emptyRiskBook();
  const now = context.now ?? Date.now();

  if (book.killSwitchTripped) {
    return verdict(config, {
      code: "KILL_SWITCH",
      reason: book.killSwitchReason ?? "Kill switch is tripped; no further trades until reset.",
      dailyPnlUsd: book.dailyPnlUsd,
    });
  }

  if (book.dailyPnlUsd <= -config.risk.maxDailyLossUsd) {
    const reason = `Daily PnL ${book.dailyPnlUsd} USD reached max daily loss ${config.risk.maxDailyLossUsd} USD; kill switch tripped.`;
    armKillSwitch(book, reason);
    return verdict(config, {
      code: "MAX_DAILY_LOSS",
      reason,
      dailyPnlUsd: book.dailyPnlUsd,
    });
  }

  const opportunity = context.opportunity;
  if (!opportunity) {
    return verdict(config, {
      code: "MISSING_OPPORTUNITY",
      reason: "Risk engine received no opportunity; refusing to trade without a sized quote.",
    });
  }

  const notional = context.proposedNotionalUsd ?? opportunity.sizeUsd;

  if (opportunity.assetStatus !== "ASSET_STATUS_ACTIVE") {
    return verdict(config, {
      code: "ASSET_INACTIVE",
      reason: `Asset status is ${opportunity.assetStatus}, not ASSET_STATUS_ACTIVE.`,
      symbol: opportunity.symbol,
      proposedNotionalUsd: notional,
    });
  }
  if (context.currentAssetStatus && context.currentAssetStatus !== "ASSET_STATUS_ACTIVE") {
    return verdict(config, {
      code: "ASSET_INACTIVE",
      reason: `Live asset status is ${context.currentAssetStatus}, not ASSET_STATUS_ACTIVE.`,
      symbol: opportunity.symbol,
      proposedNotionalUsd: notional,
    });
  }

  if (opportunity.isTradingHalt || context.currentHalt) {
    return verdict(config, {
      code: "TRADING_HALT",
      reason: "Trading is halted for this symbol.",
      symbol: opportunity.symbol,
      proposedNotionalUsd: notional,
    });
  }

  if (isOpportunityExpired(opportunity, now)) {
    return verdict(config, {
      code: "OPPORTUNITY_EXPIRED",
      reason: `Opportunity expired at ${opportunity.expiresAt.toISOString()} (TTL ${opportunity.ttlMs}ms).`,
      symbol: opportunity.symbol,
      proposedNotionalUsd: notional,
    });
  }

  if (
    context.currentMultiplier !== undefined &&
    context.currentMultiplier !== opportunity.multiplier
  ) {
    return verdict(config, {
      code: "MULTIPLIER_CHANGED",
      reason: "uiMultiplier changed since the quote was built; refusing to execute on a stale corporate-action unit.",
      symbol: opportunity.symbol,
      proposedNotionalUsd: notional,
    });
  }

  if (notional > config.risk.maxSingleTradeUsd) {
    return verdict(config, {
      code: "MAX_SINGLE_TRADE",
      reason: `Proposed notional ${notional} USD exceeds max single trade ${config.risk.maxSingleTradeUsd} USD.`,
      symbol: opportunity.symbol,
      proposedNotionalUsd: notional,
    });
  }

  const currentPos = book.positionsUsdBySymbol[opportunity.symbol] ?? 0;
  const delta = opportunity.side === "buy_dex" ? notional : -notional;
  const positionAfter = currentPos + delta;
  if (Math.abs(positionAfter) > config.risk.maxPositionPerSymbolUsd) {
    return verdict(config, {
      code: "MAX_POSITION",
      reason: `Position after trade would be ${positionAfter} USD, above max ${config.risk.maxPositionPerSymbolUsd} USD per symbol.`,
      symbol: opportunity.symbol,
      proposedNotionalUsd: notional,
      positionAfterUsd: positionAfter,
    });
  }

  if (opportunity.costs.slippageBps > config.risk.maxSlippageBps) {
    return verdict(config, {
      code: "MAX_SLIPPAGE",
      reason: `Quoted slippage ${opportunity.costs.slippageBps} bps exceeds max ${config.risk.maxSlippageBps} bps.`,
      symbol: opportunity.symbol,
      proposedNotionalUsd: notional,
    });
  }

  if (opportunity.costs.netEdgeBps < config.risk.minNetEdgeBps) {
    return verdict(config, {
      code: "MIN_NET_EDGE_BPS",
      reason: `Net edge ${opportunity.costs.netEdgeBps} bps is below min ${config.risk.minNetEdgeBps} bps.`,
      symbol: opportunity.symbol,
      proposedNotionalUsd: notional,
    });
  }

  if (Number(opportunity.costs.netEdgeUsd) < config.minNetEdgeUsd) {
    return verdict(config, {
      code: "MIN_NET_EDGE_USD",
      reason: `Net edge ${opportunity.costs.netEdgeUsd} USD is below min ${config.minNetEdgeUsd} USD.`,
      symbol: opportunity.symbol,
      proposedNotionalUsd: notional,
    });
  }

  return verdict(config, {
    allowed: true,
    code: "ALLOWED",
    reason: "All risk checks passed.",
    symbol: opportunity.symbol,
    proposedNotionalUsd: notional,
    positionAfterUsd: positionAfter,
    dailyPnlUsd: book.dailyPnlUsd,
  });
}

export function tripKillSwitch(book: RiskBook, reason: string): void {
  const already = book.killSwitchTripped;
  book.killSwitchTripped = true;
  book.killSwitchReason = reason;
  if (!already && !book.killSwitchAlerted) {
    book.killSwitchNeedsAlert = true;
  }
  log.error("risk.kill_switch", { allowed: false, code: "KILL_SWITCH", reason });
}

export function resetKillSwitch(book: RiskBook): void {
  book.killSwitchTripped = false;
  book.killSwitchReason = undefined;
  book.killSwitchAlerted = false;
  book.killSwitchNeedsAlert = false;
}

export function recordFill(
  book: RiskBook,
  args: { symbol: string; signedNotionalUsd: number; realizedPnlUsd: number },
): void {
  const current = book.positionsUsdBySymbol[args.symbol] ?? 0;
  book.positionsUsdBySymbol[args.symbol] = current + args.signedNotionalUsd;
  book.dailyPnlUsd += args.realizedPnlUsd;
}

export function assertRiskAllowed(result: RiskVerdict): void {
  if (!result.allowed) {
    throw new Error(`Risk engine veto: ${result.reason}`);
  }
}
