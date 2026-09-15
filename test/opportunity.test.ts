import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { PRICE_UNIT } from "../src/config/constants.js";
import { loadConfig } from "../src/config/env.js";
import type { Price } from "../src/domain/price.js";
import type { SymbolSnapshot } from "../src/marketdata/collect.js";
import type { DexQuote } from "../src/marketdata/dex/types.js";
import { parseDecimalToScaled } from "../src/normalize/units.js";
import { findOpportunities, isOpportunityExpired } from "../src/opportunity/engine.js";

const NOW = Date.parse("2026-09-15T12:00:00.000Z");
const TOKEN = getAddress("0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9");
const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const MULT = parseDecimalToScaled("1");

function usdPrice(value: string, source: Price["source"], side: Price["side"]): Price {
  const valueUsdScaled = parseDecimalToScaled(value);
  return {
    symbol: "AAPL",
    source,
    timestamp: new Date(NOW),
    multiplier: MULT,
    unit: PRICE_UNIT,
    side,
    valueUsdScaled,
    valueUsd: value,
  };
}

function quote(args: {
  venue?: DexQuote["venue"];
  side: "buy_token" | "sell_token";
  executableUsd: string;
  stub?: boolean;
  gasUsd?: string;
  slippageBps?: number;
  feeBps?: number;
}): DexQuote {
  const side = args.side === "buy_token" ? "executable_buy" : "executable_sell";
  return {
    venue: args.venue ?? "uniswap",
    stub: args.stub ?? false,
    request: {
      symbol: "AAPL",
      token: TOKEN,
      quoteToken: USDG,
      quoteTokenSymbol: "USDG",
      quoteTokenDecimals: 6,
      tokenDecimals: 18,
      sizeUsd: 200,
      multiplier: MULT,
      side: args.side,
    },
    executable: usdPrice(
      args.executableUsd,
      args.stub ? "dex_uniswap_stub" : args.venue === "arcus" ? "dex_arcus" : "dex_uniswap",
      side,
    ),
    feeBps: args.feeBps ?? 0,
    estimatedSlippageBps: args.slippageBps ?? 30,
    estimatedGasUsd: args.gasUsd ?? "0.05",
    gasSource: "uniswap_quote",
  };
}

function snapshot(overrides: Partial<SymbolSnapshot> = {}): SymbolSnapshot {
  const restBid = usdPrice("101", "rest_reference", "bid");
  const restAsk = usdPrice("101", "rest_reference", "ask");
  return {
    symbol: "AAPL",
    assetStatus: "ASSET_STATUS_ACTIVE",
    token: TOKEN,
    multiplier: "1",
    multiplierSource: "registry_currentMultiplier",
    isTradingHalt: false,
    rest: {
      tokenSymbol: "AAPL",
      bid: "101",
      ask: "101",
      currency: "USD",
      isTradingHalt: false,
      generatedAt: new Date(NOW),
      bidTokenUsd: restBid,
      askTokenUsd: restAsk,
    },
    dexQuotes: [],
    errors: [],
    ...overrides,
  };
}

function testConfig() {
  return loadConfig({
    SYMBOLS: "AAPL",
    MAX_SINGLE_TRADE_USD: "200",
    MIN_NET_EDGE_BPS: "50",
    MIN_NET_EDGE_USD: "0.5",
    MAX_SLIPPAGE_BPS: "30",
    RISK_BUFFER_BPS: "10",
    ESTIMATED_GAS_USD: "0.05",
    OPPORTUNITY_TTL_MS: "5000",
    ONCHAIN_MAX_AGE_MS: "5000",
    REST_MAX_AGE_MS: "20000",
  });
}

describe("opportunity engine", () => {
  it("flags a profitable DEX-cheap vs reference case after costs", () => {
    const config = testConfig();
    const scan = findOpportunities({
      now: NOW,
      config,
      snapshots: [
        snapshot({
          dexQuotes: [quote({ side: "buy_token", executableUsd: "100" })],
        }),
      ],
    });
    expect(scan.opportunities).toHaveLength(1);
    const opp = scan.opportunities[0]!;
    expect(opp.kind).toBe("reference_vs_onchain");
    expect(opp.side).toBe("buy_dex");
    expect(opp.costs.grossEdgeBps).toBeGreaterThanOrEqual(100);
    expect(opp.costs.netEdgeBps).toBeGreaterThanOrEqual(50);
    expect(Number(opp.costs.netEdgeUsd)).toBeGreaterThanOrEqual(0.5);
    expect(opp.costs.gasUsd).toBe("0.05");
    expect(opp.ttlMs).toBe(5000);
    expect(isOpportunityExpired(opp, NOW + 4999)).toBe(false);
    expect(isOpportunityExpired(opp, NOW + 5000)).toBe(true);
  });

  it("rejects an unprofitable case after fees, slippage, gas, and risk buffer", () => {
    const config = testConfig();
    const scan = findOpportunities({
      now: NOW,
      config,
      snapshots: [
        snapshot({
          rest: {
            tokenSymbol: "AAPL",
            bid: "100.40",
            ask: "100.40",
            currency: "USD",
            isTradingHalt: false,
            generatedAt: new Date(NOW),
            bidTokenUsd: usdPrice("100.40", "rest_reference", "bid"),
            askTokenUsd: usdPrice("100.40", "rest_reference", "ask"),
          },
          dexQuotes: [quote({ side: "buy_token", executableUsd: "100" })],
        }),
      ],
    });
    expect(scan.opportunities).toHaveLength(0);
    expect(scan.rejections.some((r) => r.kind === "reference_vs_onchain" && r.costs)).toBe(true);
    const withCosts = scan.rejections.find((r) => r.costs);
    expect(withCosts?.costs?.netEdgeUsdScaled).toBeLessThanOrEqual(0n);
  });

  it("never promotes stub DEX quotes to opportunities", () => {
    const scan = findOpportunities({
      now: NOW,
      config: testConfig(),
      snapshots: [
        snapshot({
          dexQuotes: [quote({ side: "buy_token", executableUsd: "50", stub: true })],
        }),
      ],
    });
    expect(scan.opportunities).toHaveLength(0);
    expect(scan.rejections.some((r) => /stub/i.test(r.reason))).toBe(true);
  });

  it("detects a profitable cross-venue fixture without inventing live Arcus quotes", () => {
    const scan = findOpportunities({
      now: NOW,
      config: testConfig(),
      snapshots: [
        snapshot({
          dexQuotes: [
            quote({ venue: "uniswap", side: "buy_token", executableUsd: "100" }),
            quote({ venue: "arcus", side: "sell_token", executableUsd: "101" }),
          ],
        }),
      ],
    });
    expect(scan.opportunities.some((o) => o.kind === "cross_venue")).toBe(true);
    const cross = scan.opportunities.find((o) => o.kind === "cross_venue")!;
    expect(cross.buyVenue).toBe("uniswap");
    expect(cross.sellVenue).toBe("arcus");
    expect(cross.costs.netEdgeBps).toBeGreaterThanOrEqual(50);
  });
});
