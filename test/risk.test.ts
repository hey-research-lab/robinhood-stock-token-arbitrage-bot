import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { PRICE_UNIT } from "../src/config/constants.js";
import { loadConfig } from "../src/config/env.js";
import type { Price } from "../src/domain/price.js";
import { parseDecimalToScaled } from "../src/normalize/units.js";
import { computeCosts } from "../src/opportunity/cost-model.js";
import type { Opportunity } from "../src/opportunity/types.js";
import {
  emptyRiskBook,
  evaluateRisk,
  recordFill,
  resetKillSwitch,
  tripKillSwitch,
} from "../src/risk/engine.js";

const NOW = Date.parse("2026-09-15T12:00:00.000Z");
const TOKEN = getAddress("0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9");
const MULT = parseDecimalToScaled("1");

function usdPrice(value: string): Price {
  return {
    symbol: "AAPL",
    source: "dex_uniswap",
    timestamp: new Date(NOW),
    multiplier: MULT,
    unit: PRICE_UNIT,
    side: "executable_buy",
    valueUsdScaled: parseDecimalToScaled(value),
    valueUsd: value,
  };
}

function passingOpportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  const costs = computeCosts({
    grossEdgeUsdScaled: parseDecimalToScaled("2"),
    notionalUsdScaled: parseDecimalToScaled("200"),
    extraFeeBps: 0,
    slippageBps: 30,
    gasUsdScaled: parseDecimalToScaled("0.05"),
    gasSource: "uniswap_quote",
    riskBufferBps: 10,
  });
  return {
    id: "AAPL:reference_vs_onchain:buy_dex:test",
    kind: "reference_vs_onchain",
    symbol: "AAPL",
    side: "buy_dex",
    buyVenue: "uniswap",
    sellVenue: "reference",
    token: TOKEN,
    multiplier: MULT,
    multiplierDecimal: "1",
    sizeUsd: 200,
    reference: { ...usdPrice("101"), source: "rest_reference", side: "mid" },
    dex: usdPrice("100"),
    costs,
    detectedAt: new Date(NOW),
    expiresAt: new Date(NOW + 5_000),
    ttlMs: 5_000,
    assetStatus: "ASSET_STATUS_ACTIVE",
    isTradingHalt: false,
    ...overrides,
  };
}

function config() {
  return loadConfig({
    SYMBOLS: "AAPL",
    MAX_POSITION_PER_SYMBOL_USD: "500",
    MAX_SINGLE_TRADE_USD: "200",
    MAX_DAILY_LOSS_USD: "250",
    MIN_NET_EDGE_BPS: "50",
    MIN_NET_EDGE_USD: "0.5",
    MAX_SLIPPAGE_BPS: "30",
    RISK_BUFFER_BPS: "10",
  });
}

describe("risk engine", () => {
  it("allows a sized, fresh, in-limit opportunity", () => {
    const book = emptyRiskBook();
    const result = evaluateRisk(config(), {
      opportunity: passingOpportunity(),
      book,
      now: NOW,
    });
    expect(result.allowed).toBe(true);
    expect(result.code).toBe("ALLOWED");
    expect(result.positionAfterUsd).toBe(200);
  });

  it("vetoes when no opportunity is provided", () => {
    const result = evaluateRisk(config(), { book: emptyRiskBook() });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("MISSING_OPPORTUNITY");
  });

  it("vetoes max single trade notional", () => {
    const result = evaluateRisk(config(), {
      opportunity: passingOpportunity({ sizeUsd: 201 }),
      proposedNotionalUsd: 201,
      book: emptyRiskBook(),
      now: NOW,
    });
    expect(result.code).toBe("MAX_SINGLE_TRADE");
    expect(result.allowed).toBe(false);
  });

  it("vetoes when the trade would exceed max position per symbol", () => {
    const book = emptyRiskBook();
    book.positionsUsdBySymbol.AAPL = 400;
    const result = evaluateRisk(config(), {
      opportunity: passingOpportunity(),
      book,
      now: NOW,
    });
    expect(result.code).toBe("MAX_POSITION");
    expect(result.positionAfterUsd).toBe(600);
  });

  it("vetoes a sell that would exceed max short exposure", () => {
    const book = emptyRiskBook();
    book.positionsUsdBySymbol.AAPL = -400;
    const result = evaluateRisk(config(), {
      opportunity: passingOpportunity({ side: "sell_dex" }),
      book,
      now: NOW,
    });
    expect(result.code).toBe("MAX_POSITION");
    expect(result.positionAfterUsd).toBe(-600);
  });

  it("vetoes slippage above the configured cap", () => {
    const opportunity = passingOpportunity();
    opportunity.costs = { ...opportunity.costs, slippageBps: 31 };
    const result = evaluateRisk(config(), { opportunity, book: emptyRiskBook(), now: NOW });
    expect(result.code).toBe("MAX_SLIPPAGE");
  });

  it("vetoes net edge below min bps", () => {
    const opportunity = passingOpportunity();
    opportunity.costs = { ...opportunity.costs, netEdgeBps: 49, netEdgeUsd: "5" };
    const result = evaluateRisk(config(), { opportunity, book: emptyRiskBook(), now: NOW });
    expect(result.code).toBe("MIN_NET_EDGE_BPS");
  });

  it("vetoes net edge below min USD", () => {
    const opportunity = passingOpportunity();
    opportunity.costs = { ...opportunity.costs, netEdgeBps: 80, netEdgeUsd: "0.4" };
    const result = evaluateRisk(config(), { opportunity, book: emptyRiskBook(), now: NOW });
    expect(result.code).toBe("MIN_NET_EDGE_USD");
  });

  it("vetoes an expired opportunity", () => {
    const result = evaluateRisk(config(), {
      opportunity: passingOpportunity(),
      book: emptyRiskBook(),
      now: NOW + 5_000,
    });
    expect(result.code).toBe("OPPORTUNITY_EXPIRED");
  });

  it("vetoes inactive assets and halted trading", () => {
    const inactive = evaluateRisk(config(), {
      opportunity: passingOpportunity({ assetStatus: "ASSET_STATUS_INACTIVE" }),
      book: emptyRiskBook(),
      now: NOW,
    });
    expect(inactive.code).toBe("ASSET_INACTIVE");

    const liveInactive = evaluateRisk(config(), {
      opportunity: passingOpportunity(),
      currentAssetStatus: "ASSET_STATUS_INACTIVE",
      book: emptyRiskBook(),
      now: NOW,
    });
    expect(liveInactive.code).toBe("ASSET_INACTIVE");

    const halted = evaluateRisk(config(), {
      opportunity: passingOpportunity({ isTradingHalt: true }),
      book: emptyRiskBook(),
      now: NOW,
    });
    expect(halted.code).toBe("TRADING_HALT");

    const liveHalt = evaluateRisk(config(), {
      opportunity: passingOpportunity(),
      currentHalt: true,
      book: emptyRiskBook(),
      now: NOW,
    });
    expect(liveHalt.code).toBe("TRADING_HALT");
  });

  it("vetoes when the multiplier changed since the quote", () => {
    const result = evaluateRisk(config(), {
      opportunity: passingOpportunity(),
      currentMultiplier: parseDecimalToScaled("1.05"),
      book: emptyRiskBook(),
      now: NOW,
    });
    expect(result.code).toBe("MULTIPLIER_CHANGED");
  });

  it("trips the kill switch on max daily loss and keeps blocking after PnL recovers", () => {
    const book = emptyRiskBook();
    book.dailyPnlUsd = -250;
    const first = evaluateRisk(config(), {
      opportunity: passingOpportunity(),
      book,
      now: NOW,
    });
    expect(first.allowed).toBe(false);
    expect(first.code).toBe("MAX_DAILY_LOSS");
    expect(book.killSwitchTripped).toBe(true);

    book.dailyPnlUsd = 10;
    const second = evaluateRisk(config(), {
      opportunity: passingOpportunity(),
      book,
      now: NOW,
    });
    expect(second.code).toBe("KILL_SWITCH");
    expect(second.allowed).toBe(false);

    resetKillSwitch(book);
    const third = evaluateRisk(config(), {
      opportunity: passingOpportunity(),
      book,
      now: NOW,
    });
    expect(third.allowed).toBe(true);
  });

  it("honors an operator kill switch before other checks", () => {
    const book = emptyRiskBook();
    tripKillSwitch(book, "operator halt");
    const result = evaluateRisk(config(), {
      opportunity: passingOpportunity(),
      book,
      now: NOW,
    });
    expect(result.code).toBe("KILL_SWITCH");
    expect(result.reason).toContain("operator halt");
  });

  it("records fills onto the book used by later checks", () => {
    const book = emptyRiskBook();
    recordFill(book, { symbol: "AAPL", signedNotionalUsd: 200, realizedPnlUsd: -10 });
    expect(book.positionsUsdBySymbol.AAPL).toBe(200);
    expect(book.dailyPnlUsd).toBe(-10);
  });
});
