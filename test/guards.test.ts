import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.js";
import { EligibilityError, ExecutionError } from "../src/domain/errors.js";
import { evaluateEligibility } from "../src/eligibility/check.js";
import { executeTrade } from "../src/execution/engine.js";
import { TradeRegistry } from "../src/execution/registry.js";
import { UniswapQuoteError, quoteUniswapLive } from "../src/marketdata/dex/uniswap.js";
import { computeCosts } from "../src/opportunity/cost-model.js";
import { parseDecimalToScaled } from "../src/normalize/units.js";
import { PRICE_UNIT } from "../src/config/constants.js";
import type { Opportunity } from "../src/opportunity/types.js";
import { emptyRiskBook, evaluateRisk } from "../src/risk/engine.js";
import { runStrategyLoop } from "../src/strategy/loop.js";

describe("execution cannot bypass risk or eligibility", () => {
  it("vetoes when executeTrade is given no opportunity", () => {
    const config = loadConfig({ SYMBOLS: "AAPL" });
    const verdict = evaluateRisk(config, { book: emptyRiskBook() });
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe("MISSING_OPPORTUNITY");
  });

  it("refuses executeTrade when jurisdiction is blocked, before any tx", async () => {
    const config = loadConfig({
      SYMBOLS: "AAPL",
      ELIGIBLE_PERSON: "true",
      JURISDICTION: "US",
      LIVE_TRADING: "true",
    });
    await expect(
      executeTrade({
        config,
        eligibility: evaluateEligibility(config),
      }),
    ).rejects.toBeInstanceOf(EligibilityError);
  });

  it("calls risk and still refuses to send even if eligibility passes", async () => {
    const config = loadConfig({
      SYMBOLS: "AAPL",
      ELIGIBLE_PERSON: "true",
      JURISDICTION: "DE",
      LIVE_TRADING: "true",
    });
    await expect(
      executeTrade({
        config,
        eligibility: evaluateEligibility(config),
      }),
    ).rejects.toThrow(/Risk engine veto/);
  });

  it("paper-fills when risk allows and never treats that as a chain submission", async () => {
    const config = loadConfig({
      SYMBOLS: "AAPL",
      ELIGIBLE_PERSON: "true",
      JURISDICTION: "DE",
    });
    const now = Date.parse("2026-09-15T12:00:00.000Z");
    const costs = computeCosts({
      grossEdgeUsdScaled: parseDecimalToScaled("2"),
      notionalUsdScaled: parseDecimalToScaled("200"),
      extraFeeBps: 0,
      slippageBps: 30,
      gasUsdScaled: parseDecimalToScaled("0.05"),
      gasSource: "uniswap_quote",
      riskBufferBps: 10,
    });
    const opportunity: Opportunity = {
      id: "test",
      kind: "reference_vs_onchain",
      symbol: "AAPL",
      side: "buy_dex",
      token: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
      multiplier: parseDecimalToScaled("1"),
      multiplierDecimal: "1",
      sizeUsd: 200,
      reference: {
        symbol: "AAPL",
        source: "rest_reference",
        timestamp: new Date(now),
        multiplier: parseDecimalToScaled("1"),
        unit: PRICE_UNIT,
        side: "mid",
        valueUsdScaled: parseDecimalToScaled("101"),
        valueUsd: "101",
      },
      dex: {
        symbol: "AAPL",
        source: "dex_uniswap",
        timestamp: new Date(now),
        multiplier: parseDecimalToScaled("1"),
        unit: PRICE_UNIT,
        side: "executable_buy",
        valueUsdScaled: parseDecimalToScaled("100"),
        valueUsd: "100",
      },
      costs,
      detectedAt: new Date(now),
      expiresAt: new Date(now + 5_000),
      ttlMs: 5_000,
      assetStatus: "ASSET_STATUS_ACTIVE",
      isTradingHalt: false,
    };
    const trade = await executeTrade({
      config,
      eligibility: evaluateEligibility(config),
      opportunity,
      now,
      registry: new TradeRegistry(),
    });
    expect(trade.mode).toBe("paper");
    expect(trade.state).toBe("confirmed");
    expect(trade.txHash?.startsWith("paper:")).toBe(true);
  });

  it("live path still requires a wallet key and does not invent a sender", async () => {
    const config = loadConfig({
      SYMBOLS: "AAPL",
      ELIGIBLE_PERSON: "true",
      JURISDICTION: "DE",
      LIVE_TRADING: "true",
    });
    const now = Date.parse("2026-09-15T12:00:00.000Z");
    const costs = computeCosts({
      grossEdgeUsdScaled: parseDecimalToScaled("2"),
      notionalUsdScaled: parseDecimalToScaled("200"),
      extraFeeBps: 0,
      slippageBps: 30,
      gasUsdScaled: parseDecimalToScaled("0.05"),
      gasSource: "uniswap_quote",
      riskBufferBps: 10,
    });
    const opportunity: Opportunity = {
      id: "live-no-key",
      kind: "reference_vs_onchain",
      symbol: "AAPL",
      side: "buy_dex",
      token: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
      multiplier: parseDecimalToScaled("1"),
      multiplierDecimal: "1",
      sizeUsd: 200,
      reference: {
        symbol: "AAPL",
        source: "rest_reference",
        timestamp: new Date(now),
        multiplier: parseDecimalToScaled("1"),
        unit: PRICE_UNIT,
        side: "mid",
        valueUsdScaled: parseDecimalToScaled("101"),
        valueUsd: "101",
      },
      dex: {
        symbol: "AAPL",
        source: "dex_uniswap",
        timestamp: new Date(now),
        multiplier: parseDecimalToScaled("1"),
        unit: PRICE_UNIT,
        side: "executable_buy",
        valueUsdScaled: parseDecimalToScaled("100"),
        valueUsd: "100",
      },
      costs,
      detectedAt: new Date(now),
      expiresAt: new Date(now + 5_000),
      ttlMs: 5_000,
      assetStatus: "ASSET_STATUS_ACTIVE",
      isTradingHalt: false,
    };
    await expect(
      executeTrade({
        config,
        eligibility: evaluateEligibility(config),
        opportunity,
        now,
        registry: new TradeRegistry(),
        env: { LIVE_TRADING: "true" },
      }),
    ).rejects.toBeInstanceOf(ExecutionError);
  });

  it("does not start the strategy loop without eligibility", async () => {
    const config = loadConfig({ SYMBOLS: "AAPL" });
    await expect(
      runStrategyLoop(evaluateEligibility(config), { snapshots: [], config }),
    ).rejects.toBeInstanceOf(EligibilityError);
  });

  it("does not call Uniswap Trading API without a key", async () => {
    await expect(
      quoteUniswapLive(
        {
          symbol: "AAPL",
          token: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
          quoteToken: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
          quoteTokenSymbol: "USDG",
          quoteTokenDecimals: 6,
          tokenDecimals: 18,
          sizeUsd: 200,
          multiplier: 10n ** 18n,
          side: "buy_token",
        },
        { apiKey: "", estimatedGasUsd: 0.05 },
      ),
    ).rejects.toBeInstanceOf(UniswapQuoteError);
  });
});
