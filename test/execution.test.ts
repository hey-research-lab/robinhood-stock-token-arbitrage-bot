import { getAddress, type Address, type Hash, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { UNISWAP_UNIVERSAL_ROUTER_4663 } from "../src/config/constants.js";
import { loadConfig } from "../src/config/env.js";
import { EligibilityError, ExecutionError } from "../src/domain/errors.js";
import { evaluateEligibility } from "../src/eligibility/check.js";
import { executeTrade } from "../src/execution/engine.js";
import { paperFillPriceScaled } from "../src/execution/paper.js";
import { TradeRegistry } from "../src/execution/registry.js";
import type { SwapBroadcast } from "../src/execution/types.js";
import { prepareSwapRequest, validateSwapBeforeBroadcast } from "../src/execution/uniswap-swap.js";
import { parseDecimalToScaled } from "../src/normalize/units.js";
import { computeCosts } from "../src/opportunity/cost-model.js";
import type { Opportunity } from "../src/opportunity/types.js";
import { emptyRiskBook } from "../src/risk/engine.js";
import { PRICE_UNIT } from "../src/config/constants.js";

const NOW = Date.parse("2026-09-15T12:00:00.000Z");
const TOKEN = getAddress("0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9");
const WALLET = getAddress("0x1111111111111111111111111111111111111111");
const TX = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Hash;

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
    multiplier: parseDecimalToScaled("1"),
    multiplierDecimal: "1",
    sizeUsd: 200,
    reference: {
      symbol: "AAPL",
      source: "rest_reference",
      timestamp: new Date(NOW),
      multiplier: parseDecimalToScaled("1"),
      unit: PRICE_UNIT,
      side: "mid",
      valueUsdScaled: parseDecimalToScaled("101"),
      valueUsd: "101",
    },
    dex: {
      symbol: "AAPL",
      source: "dex_uniswap",
      timestamp: new Date(NOW),
      multiplier: parseDecimalToScaled("1"),
      unit: PRICE_UNIT,
      side: "executable_buy",
      valueUsdScaled: parseDecimalToScaled("100"),
      valueUsd: "100",
    },
    costs,
    detectedAt: new Date(NOW),
    expiresAt: new Date(NOW + 5_000),
    ttlMs: 5_000,
    assetStatus: "ASSET_STATUS_ACTIVE",
    isTradingHalt: false,
    ...overrides,
  };
}

function paperConfig() {
  return loadConfig({ SYMBOLS: "AAPL" });
}

function eligibleLiveConfig(extra: Record<string, string> = {}) {
  return loadConfig({
    SYMBOLS: "AAPL",
    ELIGIBLE_PERSON: "true",
    JURISDICTION: "DE",
    LIVE_TRADING: "true",
    UNISWAP_API_KEY: "test-key",
    ROBINHOOD_RPC_URL: "https://example.invalid/rpc",
    ...extra,
  });
}

function spyBroadcast(): SwapBroadcast & { sent: Array<{ to: Address; data: Hex; value: bigint }> } {
  const sent: Array<{ to: Address; data: Hex; value: bigint }> = [];
  return {
    address: WALLET,
    sent,
    async send(tx) {
      sent.push(tx);
      return { hash: TX };
    },
    async wait() {
      return { status: "success" };
    },
  };
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as Response;
}

function liveFetch(args?: { routing?: string; swapData?: string; quoteOutput?: string }): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (url.includes("/quote")) {
      const output = args?.quoteOutput ?? "2000000000000000000";
      return jsonResponse({
        routing: args?.routing ?? "CLASSIC",
        quote: {
          input: { amount: "200000000" },
          output: { amount: output },
          gasFeeUSD: "0.05",
        },
      });
    }
    if (url.includes("/check_approval")) {
      return jsonResponse({});
    }
    if (url.includes("/swap")) {
      return jsonResponse({
        swap: {
          to: UNISWAP_UNIVERSAL_ROUTER_4663,
          from: WALLET,
          data: args?.swapData ?? "0xabcdef",
          value: "0",
          chainId: 4663,
          gasLimit: "250000",
        },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}

describe("paper simulator", () => {
  it("applies slippage, fees, and gas then confirms without broadcasting", async () => {
    const config = paperConfig();
    const book = emptyRiskBook();
    const registry = new TradeRegistry();
    const broadcast = spyBroadcast();
    const opportunity = passingOpportunity();

    const trade = await executeTrade({
      config,
      eligibility: evaluateEligibility(config),
      opportunity,
      book,
      now: NOW,
      registry,
      broadcast,
    });

    expect(trade.mode).toBe("paper");
    expect(trade.state).toBe("confirmed");
    expect(trade.states.map((s) => s.state)).toEqual([
      "validated",
      "quoted",
      "submitted",
      "pending",
      "confirmed",
    ]);
    expect(trade.txHash).toBe(`paper:${opportunity.id}`);
    expect(trade.fillPriceUsd).toBe("100.3");
    expect(paperFillPriceScaled(opportunity)).toBe(parseDecimalToScaled("100.3"));
    expect(trade.gasUsd).toBe("0.05");
    expect(trade.slippageUsd).toBe("0.6");
    expect(trade.realizedPnlUsd).toBe("1.15");
    expect(trade.signedNotionalUsd).toBe(200);
    expect(book.positionsUsdBySymbol.AAPL).toBe(200);
    expect(book.dailyPnlUsd).toBe(1.15);
    expect(broadcast.sent).toHaveLength(0);
  });

  it("paper-fills even when eligibility is blocked", async () => {
    const config = loadConfig({ SYMBOLS: "AAPL", ELIGIBLE_PERSON: "false", JURISDICTION: "US" });
    const trade = await executeTrade({
      config,
      eligibility: evaluateEligibility(config),
      opportunity: passingOpportunity({ id: "paper-ineligible" }),
      book: emptyRiskBook(),
      now: NOW,
      registry: new TradeRegistry(),
    });
    expect(trade.mode).toBe("paper");
    expect(trade.state).toBe("confirmed");
  });

  it("still refuses paper when risk vetoes", async () => {
    const config = paperConfig();
    await expect(
      executeTrade({
        config,
        eligibility: evaluateEligibility(config),
        book: emptyRiskBook(),
        now: NOW,
        registry: new TradeRegistry(),
      }),
    ).rejects.toThrow(/Risk engine veto/);
  });

  it("refuses to paper-fill the same opportunity twice", async () => {
    const config = paperConfig();
    const registry = new TradeRegistry();
    const args = {
      config,
      eligibility: evaluateEligibility(config),
      opportunity: passingOpportunity({ id: "once-only" }),
      book: emptyRiskBook(),
      now: NOW,
      registry,
    };
    await executeTrade(args);
    await expect(executeTrade(args)).rejects.toThrow(/double-execute/);
  });
});

describe("live path", () => {
  it("blocks live execution for a blocked jurisdiction before any send", async () => {
    const config = loadConfig({
      SYMBOLS: "AAPL",
      ELIGIBLE_PERSON: "true",
      JURISDICTION: "US",
      LIVE_TRADING: "true",
      UNISWAP_API_KEY: "test-key",
      ROBINHOOD_RPC_URL: "https://example.invalid/rpc",
    });
    const broadcast = spyBroadcast();
    await expect(
      executeTrade({
        config,
        eligibility: evaluateEligibility(config),
        opportunity: passingOpportunity(),
        book: emptyRiskBook(),
        now: NOW,
        registry: new TradeRegistry(),
        broadcast,
        fetchImpl: liveFetch(),
      }),
    ).rejects.toBeInstanceOf(EligibilityError);
    expect(broadcast.sent).toHaveLength(0);
  });

  it("does not build a wallet or send when LIVE_TRADING is true but no key is configured", async () => {
    const config = eligibleLiveConfig();
    expect(config.walletPrivateKeyConfigured).toBe(false);
    await expect(
      executeTrade({
        config,
        eligibility: evaluateEligibility(config),
        opportunity: passingOpportunity(),
        book: emptyRiskBook(),
        now: NOW,
        registry: new TradeRegistry(),
        env: { SYMBOLS: "AAPL" },
      }),
    ).rejects.toThrow(/WALLET_PRIVATE_KEY/);
  });

  it("submits then confirms a CLASSIC swap after risk allows", async () => {
    const config = eligibleLiveConfig();
    const book = emptyRiskBook();
    const broadcast = spyBroadcast();
    const trade = await executeTrade({
      config,
      eligibility: evaluateEligibility(config),
      opportunity: passingOpportunity({ id: "live-classic" }),
      book,
      now: NOW,
      registry: new TradeRegistry(),
      broadcast,
      fetchImpl: liveFetch(),
    });
    expect(trade.mode).toBe("live");
    expect(trade.state).toBe("confirmed");
    expect(trade.txHash).toBe(TX);
    expect(trade.states.map((s) => s.state)).toContain("submitted");
    expect(trade.states.map((s) => s.state)).toContain("pending");
    expect(broadcast.sent).toHaveLength(1);
    expect(broadcast.sent[0]?.to).toBe(UNISWAP_UNIVERSAL_ROUTER_4663);
    expect(book.positionsUsdBySymbol.AAPL).toBe(200);
  });

  it("does not broadcast empty swap calldata", async () => {
    const config = eligibleLiveConfig();
    const broadcast = spyBroadcast();
    await expect(
      executeTrade({
        config,
        eligibility: evaluateEligibility(config),
        opportunity: passingOpportunity({ id: "empty-data" }),
        book: emptyRiskBook(),
        now: NOW,
        registry: new TradeRegistry(),
        broadcast,
        fetchImpl: liveFetch({ swapData: "0x" }),
      }),
    ).rejects.toThrow(/swap.data is empty/);
    expect(broadcast.sent).toHaveLength(0);
  });

  it("refuses UniswapX live orders before broadcast", async () => {
    const config = eligibleLiveConfig();
    const broadcast = spyBroadcast();
    await expect(
      executeTrade({
        config,
        eligibility: evaluateEligibility(config),
        opportunity: passingOpportunity({ id: "uniswapx" }),
        book: emptyRiskBook(),
        now: NOW,
        registry: new TradeRegistry(),
        broadcast,
        fetchImpl: liveFetch({ routing: "DUTCH_V2" }),
      }),
    ).rejects.toThrow(/UniswapX/);
    expect(broadcast.sent).toHaveLength(0);
  });

  it("refuses live cross-venue until a second DEX is wired", async () => {
    const config = eligibleLiveConfig();
    const broadcast = spyBroadcast();
    await expect(
      executeTrade({
        config,
        eligibility: evaluateEligibility(config),
        opportunity: passingOpportunity({ id: "cross", kind: "cross_venue", buyVenue: "uniswap", sellVenue: "arcus" }),
        book: emptyRiskBook(),
        now: NOW,
        registry: new TradeRegistry(),
        broadcast,
        fetchImpl: liveFetch(),
      }),
    ).rejects.toThrow(/cross-venue/);
    expect(broadcast.sent).toHaveLength(0);
  });

  it("aborts when the fresh executable moved more than max slippage", async () => {
    const config = eligibleLiveConfig();
    const broadcast = spyBroadcast();
    await expect(
      executeTrade({
        config,
        eligibility: evaluateEligibility(config),
        opportunity: passingOpportunity({ id: "moved" }),
        book: emptyRiskBook(),
        now: NOW,
        registry: new TradeRegistry(),
        broadcast,
        fetchImpl: liveFetch({ quoteOutput: "1000000000000000000" }),
      }),
    ).rejects.toThrow(/moved more than/);
    expect(broadcast.sent).toHaveLength(0);
  });

  it("does not record a fill when the transaction reverts after submit", async () => {
    const config = eligibleLiveConfig();
    const book = emptyRiskBook();
    const broadcast: SwapBroadcast = {
      address: WALLET,
      async send() {
        return { hash: TX };
      },
      async wait() {
        return { status: "reverted" };
      },
    };
    await expect(
      executeTrade({
        config,
        eligibility: evaluateEligibility(config),
        opportunity: passingOpportunity({ id: "reverted" }),
        book,
        now: NOW,
        registry: new TradeRegistry(),
        broadcast,
        fetchImpl: liveFetch(),
      }),
    ).rejects.toThrow(/reverted/);
    expect(book.positionsUsdBySymbol.AAPL).toBeUndefined();
    expect(book.dailyPnlUsd).toBe(0);
  });
});

describe("swap request helpers", () => {
  it("strips permitData null and does not wrap the quote", () => {
    const body = prepareSwapRequest({
      routing: "CLASSIC",
      quote: { input: { amount: "1" } },
      permitData: null,
      permitTransaction: null,
    });
    expect(body).toEqual({ routing: "CLASSIC", quote: { input: { amount: "1" } } });
    expect("permitData" in body).toBe(false);
  });

  it("omits UniswapX permitData even when present", () => {
    const body = prepareSwapRequest(
      {
        routing: "DUTCH_V2",
        permitData: { domain: {} },
        quote: { encodedOrder: "0xab" },
      },
      "0xsig",
    );
    expect(body.signature).toBe("0xsig");
    expect("permitData" in body).toBe(false);
  });

  it("rejects a swap aimed at an unexpected router", () => {
    expect(() =>
      validateSwapBeforeBroadcast({
        data: "0xabcdef",
        to: WALLET,
        from: WALLET,
        chainId: 4663,
      }),
    ).toThrow(/Universal Router/);
  });
});
