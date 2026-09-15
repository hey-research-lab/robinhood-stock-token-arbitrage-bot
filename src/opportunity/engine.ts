import type { AppConfig } from "../config/env.js";
import type { Price } from "../domain/price.js";
import { isFresh } from "../domain/price.js";
import { log } from "../logging/logger.js";
import type { SymbolSnapshot } from "../marketdata/collect.js";
import type { DexQuote, DexVenue } from "../marketdata/dex/types.js";
import { formatScaled, usdNumberToScaled } from "../normalize/units.js";
import { computeCosts, parseGasUsd } from "./cost-model.js";
import type {
  Opportunity,
  OpportunityKind,
  OpportunityRejection,
  OpportunityScan,
  OpportunitySide,
} from "./types.js";

function restMid(snapshot: SymbolSnapshot): Price | undefined {
  const bid = snapshot.rest?.bidTokenUsd;
  const ask = snapshot.rest?.askTokenUsd;
  if (!bid || !ask) return undefined;
  return {
    ...bid,
    side: "mid",
    valueUsdScaled: (bid.valueUsdScaled + ask.valueUsdScaled) / 2n,
    valueUsd: formatScaled((bid.valueUsdScaled + ask.valueUsdScaled) / 2n),
  };
}

function pickReference(snapshot: SymbolSnapshot, restMaxAgeMs: number, chainlinkMaxAgeMs: number, now: number): Price | undefined {
  if (snapshot.chainlink && isFresh(snapshot.chainlink, chainlinkMaxAgeMs, now)) {
    return snapshot.chainlink;
  }
  const mid = restMid(snapshot);
  if (mid && isFresh(mid, restMaxAgeMs, now)) {
    return mid;
  }
  return undefined;
}

function liveQuotes(snapshot: SymbolSnapshot): DexQuote[] {
  return (snapshot.dexQuotes ?? []).filter((q) => !q.stub);
}

function serializeCosts(costs: ReturnType<typeof computeCosts>): Record<string, unknown> {
  return {
    notionalUsd: costs.notionalUsd,
    grossEdgeUsd: costs.grossEdgeUsd,
    grossEdgeBps: costs.grossEdgeBps,
    extraFeeUsd: costs.extraFeeUsd,
    extraFeeBps: costs.extraFeeBps,
    slippageUsd: costs.slippageUsd,
    slippageBps: costs.slippageBps,
    gasUsd: costs.gasUsd,
    gasSource: costs.gasSource,
    riskBufferUsd: costs.riskBufferUsd,
    riskBufferBps: costs.riskBufferBps,
    netEdgeUsd: costs.netEdgeUsd,
    netEdgeBps: costs.netEdgeBps,
  };
}

function reject(
  list: OpportunityRejection[],
  entry: OpportunityRejection,
  extra: Record<string, unknown> = {},
): void {
  list.push(entry);
  log.info("opportunity.rejected", { ...entry, ...extra, costs: entry.costs ? serializeCosts(entry.costs) : undefined });
}

function buildId(symbol: string, kind: OpportunityKind, side: OpportunitySide, detectedAt: Date): string {
  return `${symbol}:${kind}:${side}:${detectedAt.toISOString()}`;
}

export function isOpportunityExpired(opportunity: Opportunity, now = Date.now()): boolean {
  return now >= opportunity.expiresAt.getTime();
}

function evaluateCandidate(args: {
  config: AppConfig;
  snapshot: SymbolSnapshot;
  kind: OpportunityKind;
  side: OpportunitySide;
  dex: DexQuote;
  reference: Price;
  counterpart?: Price;
  buyVenue?: DexVenue | "reference";
  sellVenue?: DexVenue | "reference";
  now: number;
  rejections: OpportunityRejection[];
}): Opportunity | undefined {
  const { config, snapshot, kind, side, dex, reference, counterpart, now, rejections } = args;

  if (dex.stub) {
    reject(rejections, {
      symbol: snapshot.symbol,
      kind,
      reason: "DEX quote is a stub and is not executable",
    });
    return undefined;
  }

  if (snapshot.assetStatus !== "ASSET_STATUS_ACTIVE") {
    reject(rejections, {
      symbol: snapshot.symbol,
      kind,
      reason: `asset status is ${snapshot.assetStatus}, not ASSET_STATUS_ACTIVE`,
    });
    return undefined;
  }

  if (snapshot.isTradingHalt) {
    reject(rejections, { symbol: snapshot.symbol, kind, reason: "trading is halted" });
    return undefined;
  }

  if (dex.executable.multiplier !== reference.multiplier) {
    reject(rejections, {
      symbol: snapshot.symbol,
      kind,
      reason: "multiplier mismatch between DEX quote and reference",
      multiplier: snapshot.multiplier,
    });
    return undefined;
  }

  if (!isFresh(dex.executable, config.onchainMaxAgeMs, now)) {
    reject(rejections, { symbol: snapshot.symbol, kind, reason: "DEX quote is stale" });
    return undefined;
  }
  const refMaxAge = reference.source === "rest_reference" ? config.restMaxAgeMs : config.chainlinkMaxAgeMs;
  if (!isFresh(reference, refMaxAge, now)) {
    reject(rejections, { symbol: snapshot.symbol, kind, reason: "reference price is stale" });
    return undefined;
  }

  const dexPx = dex.executable.valueUsdScaled;
  const refPx = reference.valueUsdScaled;
  let grossPerToken: bigint;
  if (side === "buy_dex") {
    grossPerToken = refPx - dexPx;
  } else {
    grossPerToken = dexPx - refPx;
  }
  if (grossPerToken <= 0n) {
    reject(rejections, {
      symbol: snapshot.symbol,
      kind,
      reason: "no gross edge after comparing executable DEX price to reference",
      sizeUsd: config.risk.maxSingleTradeUsd,
    });
    return undefined;
  }

  const notionalUsdScaled = usdNumberToScaled(config.risk.maxSingleTradeUsd);
  const tokensApprox = dexPx > 0n ? (notionalUsdScaled * 10n ** 18n) / dexPx : 0n;
  const grossEdgeUsdScaled = (grossPerToken * tokensApprox) / 10n ** 18n;

  const extraFeeBps = dex.feeBps ?? 0;
  const slippageBps = dex.estimatedSlippageBps ?? config.risk.maxSlippageBps;
  const gasParsed = parseGasUsd(dex.estimatedGasUsd, config.estimatedGasUsd);
  const gasSource = dex.gasSource ?? (gasParsed.usedFallback ? "config_fallback" : "uniswap_quote");

  const costs = computeCosts({
    grossEdgeUsdScaled,
    notionalUsdScaled,
    extraFeeBps,
    slippageBps,
    gasUsdScaled: gasParsed.scaled,
    gasSource,
    riskBufferBps: config.risk.riskBufferBps,
  });

  const minUsd = usdNumberToScaled(config.minNetEdgeUsd);
  if (costs.netEdgeUsdScaled <= 0n) {
    reject(rejections, {
      symbol: snapshot.symbol,
      kind,
      reason: "net edge is not positive after fees, slippage, gas, and risk buffer",
      costs,
      sizeUsd: config.risk.maxSingleTradeUsd,
    });
    return undefined;
  }
  if (costs.netEdgeBps < config.risk.minNetEdgeBps) {
    reject(rejections, {
      symbol: snapshot.symbol,
      kind,
      reason: `net edge ${costs.netEdgeBps} bps below min ${config.risk.minNetEdgeBps} bps`,
      costs,
      sizeUsd: config.risk.maxSingleTradeUsd,
    });
    return undefined;
  }
  if (costs.netEdgeUsdScaled < minUsd) {
    reject(rejections, {
      symbol: snapshot.symbol,
      kind,
      reason: `net edge ${costs.netEdgeUsd} USD below min ${config.minNetEdgeUsd} USD`,
      costs,
      sizeUsd: config.risk.maxSingleTradeUsd,
    });
    return undefined;
  }

  const detectedAt = new Date(now);
  const opportunity: Opportunity = {
    id: buildId(snapshot.symbol, kind, side, detectedAt),
    kind,
    symbol: snapshot.symbol,
    side,
    buyVenue: args.buyVenue,
    sellVenue: args.sellVenue,
    token: snapshot.token,
    multiplier: reference.multiplier,
    multiplierDecimal: snapshot.multiplier,
    sizeUsd: config.risk.maxSingleTradeUsd,
    reference,
    dex: dex.executable,
    counterpart,
    costs,
    detectedAt,
    expiresAt: new Date(now + config.opportunityTtlMs),
    ttlMs: config.opportunityTtlMs,
    assetStatus: snapshot.assetStatus,
    isTradingHalt: snapshot.isTradingHalt,
  };

  log.info("opportunity.detected", {
    id: opportunity.id,
    kind: opportunity.kind,
    symbol: opportunity.symbol,
    side: opportunity.side,
    token: opportunity.token,
    multiplier: opportunity.multiplierDecimal,
    sizeUsd: opportunity.sizeUsd,
    referenceSource: reference.source,
    referenceUsd: reference.valueUsd,
    dexSource: dex.executable.source,
    dexUsd: dex.executable.valueUsd,
    ...serializeCosts(costs),
    expiresAt: opportunity.expiresAt.toISOString(),
    ttlMs: opportunity.ttlMs,
  });

  return opportunity;
}

function scanReferenceVsOnchain(
  snapshot: SymbolSnapshot,
  config: AppConfig,
  now: number,
  rejections: OpportunityRejection[],
): Opportunity[] {
  const found: Opportunity[] = [];
  const reference = pickReference(snapshot, config.restMaxAgeMs, config.chainlinkMaxAgeMs, now);
  if (!reference) {
    reject(rejections, {
      symbol: snapshot.symbol,
      kind: "reference_vs_onchain",
      reason: "no fresh Chainlink or REST reference price",
    });
    return found;
  }

  const quotes = liveQuotes(snapshot);
  if (quotes.length === 0) {
    const hadStub = (snapshot.dexQuotes ?? []).some((q) => q.stub);
    reject(rejections, {
      symbol: snapshot.symbol,
      kind: "reference_vs_onchain",
      reason: hadStub
        ? "Uniswap quote is stubbed; set UNISWAP_API_KEY for executable quotes"
        : "no DEX quotes",
    });
    return found;
  }

  for (const dex of quotes) {
    const buySide = dex.executable.side === "executable_buy" || dex.request.side === "buy_token";
    const opportunity = evaluateCandidate({
      config,
      snapshot,
      kind: "reference_vs_onchain",
      side: buySide ? "buy_dex" : "sell_dex",
      dex,
      reference,
      buyVenue: buySide ? dex.venue : "reference",
      sellVenue: buySide ? "reference" : dex.venue,
      now,
      rejections,
    });
    if (opportunity) found.push(opportunity);
  }
  return found;
}

function scanCrossVenue(
  snapshot: SymbolSnapshot,
  config: AppConfig,
  now: number,
  rejections: OpportunityRejection[],
): Opportunity[] {
  const quotes = liveQuotes(snapshot);
  const venues = new Set(quotes.map((q) => q.venue));
  if (venues.size < 2) {
    reject(rejections, {
      symbol: snapshot.symbol,
      kind: "cross_venue",
      reason:
        "cross-venue needs two live DEX venues; Arcus/Pleiades are not wired (addresses/ABIs unconfirmed)",
    });
    return [];
  }

  const found: Opportunity[] = [];
  const buys = quotes.filter((q) => q.request.side === "buy_token" || q.executable.side === "executable_buy");
  const sells = quotes.filter((q) => q.request.side === "sell_token" || q.executable.side === "executable_sell");

  for (const buy of buys) {
    for (const sell of sells) {
      if (buy.venue === sell.venue) continue;
      const opportunity = evaluateCandidate({
        config,
        snapshot,
        kind: "cross_venue",
        side: "buy_dex",
        dex: buy,
        reference: sell.executable,
        counterpart: sell.executable,
        buyVenue: buy.venue,
        sellVenue: sell.venue,
        now,
        rejections,
      });
      if (opportunity) found.push(opportunity);
    }
  }
  return found;
}

export function findOpportunities(args: {
  snapshots: SymbolSnapshot[];
  config: AppConfig;
  now?: number;
}): OpportunityScan {
  const now = args.now ?? Date.now();
  const opportunities: Opportunity[] = [];
  const rejections: OpportunityRejection[] = [];

  for (const snapshot of args.snapshots) {
    opportunities.push(...scanReferenceVsOnchain(snapshot, args.config, now, rejections));
    opportunities.push(...scanCrossVenue(snapshot, args.config, now, rejections));
  }

  return { opportunities, rejections };
}
