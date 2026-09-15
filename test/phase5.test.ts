import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, type Hash } from "viem";
import { afterEach, describe, expect, it } from "vitest";
import { PRICE_UNIT } from "../src/config/constants.js";
import { loadConfig } from "../src/config/env.js";
import { evaluateEligibility } from "../src/eligibility/check.js";
import { executeTrade } from "../src/execution/engine.js";
import { TradeRegistry } from "../src/execution/registry.js";
import { closeLogger, configureLogger, log } from "../src/logging/logger.js";
import { monitorPendingTrades, type ReceiptLookup } from "../src/monitor/monitor.js";
import { parseDecimalToScaled } from "../src/normalize/units.js";
import { computeCosts } from "../src/opportunity/cost-model.js";
import type { Opportunity } from "../src/opportunity/types.js";
import { openDatabase } from "../src/persistence/db.js";
import { reconcile } from "../src/reconcile/job.js";
import { persistRiskSideEffects } from "../src/risk/side-effects.js";
import { emptyRiskBook, tripKillSwitch } from "../src/risk/engine.js";
import type { TradeRecord } from "../src/domain/trade.js";

const NOW = Date.parse("2026-09-15T12:00:00.000Z");
const TOKEN = getAddress("0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9");
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
    id: "AAPL:reference_vs_onchain:buy_dex:phase5",
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

function pendingLiveTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  const at = new Date(NOW);
  return {
    id: "live:pending-test",
    opportunityId: "pending-live-1",
    symbol: "AAPL",
    side: "buy_dex",
    kind: "reference_vs_onchain",
    mode: "live",
    state: "pending",
    detectedAt: at,
    expiresAt: new Date(NOW + 5_000),
    submittedAt: at,
    pendingAt: at,
    txHash: TX,
    token: TOKEN,
    multiplier: "1",
    sizeUsd: 200,
    dexPriceUsd: "100",
    fillPriceUsd: "100.3",
    referencePriceUsd: "101",
    extraFeeUsd: "0",
    slippageUsd: "0.6",
    slippageBps: 30,
    gasUsd: "0.05",
    gasSource: "uniswap_quote",
    riskBufferUsd: "0.2",
    grossEdgeUsd: "2",
    netEdgeUsd: "1.15",
    realizedPnlUsd: "1.15",
    signedNotionalUsd: 200,
    riskCode: "ALLOWED",
    riskReason: "All risk checks passed.",
    fillRecorded: false,
    states: [
      { state: "validated", at },
      { state: "submitted", at },
      { state: "pending", at },
    ],
    ...overrides,
  };
}

describe("sqlite persistence", () => {
  it("survives restart and refuses to double-execute a claimed opportunity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arb-sqlite-"));
    const path = join(dir, "bot.sqlite");
    const config = loadConfig({ SYMBOLS: "AAPL", LOG_FILE: "off" });
    const opportunity = passingOpportunity({ id: "persist-once" });
    try {
      const store = openDatabase(path);
      const registry = new TradeRegistry(store);
      const book = emptyRiskBook();
      const trade = await executeTrade({
        config,
        eligibility: evaluateEligibility(config),
        opportunity,
        book,
        now: NOW,
        registry,
        store,
      });
      expect(trade.state).toBe("confirmed");
      expect(trade.fillRecorded).toBe(true);
      store.close();

      const store2 = openDatabase(path);
      const restored = store2.loadRiskBook(new Date(NOW));
      expect(restored.positionsUsdBySymbol.AAPL).toBe(200);
      expect(restored.dailyPnlUsd).toBe(1.15);
      const registry2 = new TradeRegistry(store2);
      await expect(
        executeTrade({
          config,
          eligibility: evaluateEligibility(config),
          opportunity,
          book: restored,
          now: NOW,
          registry: registry2,
          store: store2,
        }),
      ).rejects.toThrow(/double-execute/);
      store2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists a kill switch across reopen", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arb-kill-"));
    const path = join(dir, "bot.sqlite");
    try {
      const store = openDatabase(path);
      const book = emptyRiskBook();
      book.dailyPnlUsd = -250;
      const config = loadConfig({ SYMBOLS: "AAPL", LOG_FILE: "off" });
      await expect(
        executeTrade({
          config,
          eligibility: evaluateEligibility(config),
          book,
          now: NOW,
          store,
          registry: new TradeRegistry(store),
        }),
      ).rejects.toThrow(/Risk engine veto/);
      expect(book.killSwitchTripped).toBe(true);
      store.close();

      const store2 = openDatabase(path);
      const restored = store2.loadRiskBook(new Date(NOW));
      expect(restored.killSwitchTripped).toBe(true);
      store2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("tx monitor", () => {
  it("confirms a pending live hash once and records a single fill", async () => {
    const store = openDatabase(":memory:");
    const registry = new TradeRegistry(store);
    const book = emptyRiskBook();
    registry.claim(pendingLiveTrade());
    const lookup: ReceiptLookup = async () => "success";
    const first = await monitorPendingTrades({
      store,
      book,
      registry,
      getReceipt: lookup,
      now: new Date(NOW),
      pendingTimeoutMs: 900_000,
    });
    expect(first.confirmed).toBe(1);
    expect(book.positionsUsdBySymbol.AAPL).toBe(200);
    expect(registry.getByOpportunityId("pending-live-1")?.state).toBe("confirmed");
    expect(registry.getByOpportunityId("pending-live-1")?.fillRecorded).toBe(true);

    const second = await monitorPendingTrades({
      store,
      book,
      registry,
      getReceipt: lookup,
      now: new Date(NOW),
      pendingTimeoutMs: 900_000,
    });
    expect(second.confirmed).toBe(0);
    expect(book.positionsUsdBySymbol.AAPL).toBe(200);
    store.close();
  });

  it("times out a pending live tx as failed without recording a fill", async () => {
    const store = openDatabase(":memory:");
    const registry = new TradeRegistry(store);
    const book = emptyRiskBook();
    registry.claim(pendingLiveTrade({ opportunityId: "timeout-1", id: "live:timeout" }));
    const result = await monitorPendingTrades({
      store,
      book,
      registry,
      getReceipt: async () => "unknown",
      now: new Date(NOW + 1_000_000),
      pendingTimeoutMs: 900_000,
    });
    expect(result.failed).toBe(1);
    expect(book.positionsUsdBySymbol.AAPL).toBeUndefined();
    expect(registry.getByOpportunityId("timeout-1")?.state).toBe("failed");
    store.close();
  });
});

describe("reconciliation", () => {
  it("marks a paper fill reconciled and rebuilds a drifted book from fills", async () => {
    const store = openDatabase(":memory:");
    const registry = new TradeRegistry(store);
    const book = emptyRiskBook();
    const config = loadConfig({ SYMBOLS: "AAPL", LOG_FILE: "off" });
    await executeTrade({
      config,
      eligibility: evaluateEligibility(config),
      opportunity: passingOpportunity({ id: "recon-paper" }),
      book,
      now: NOW,
      registry,
      store,
    });
    book.positionsUsdBySymbol.AAPL = 999;
    book.dailyPnlUsd = 0;
    const report = await reconcile({
      store,
      book,
      registry,
      now: new Date(NOW),
    });
    expect(report.reconciled).toBe(1);
    expect(report.rebuiltPositions).toBe(true);
    expect(book.positionsUsdBySymbol.AAPL).toBe(200);
    expect(registry.getByOpportunityId("recon-paper")?.state).toBe("reconciled");
    store.close();
  });

  it("trips the kill switch when a confirmed live receipt reverted", async () => {
    const store = openDatabase(":memory:");
    const registry = new TradeRegistry(store);
    const book = emptyRiskBook();
    const at = new Date(NOW);
    registry.claim(
      pendingLiveTrade({
        opportunityId: "bad-receipt",
        state: "confirmed",
        confirmedAt: at,
        fillRecorded: true,
        states: [
          { state: "validated", at },
          { state: "confirmed", at },
        ],
      }),
    );
    book.positionsUsdBySymbol.AAPL = 200;
    book.dailyPnlUsd = 1.15;
    const report = await reconcile({
      store,
      book,
      registry,
      now: at,
      getReceipt: async () => "reverted",
    });
    expect(report.mismatches.some((m) => m.code === "RECEIPT_REVERTED")).toBe(true);
    expect(book.killSwitchTripped).toBe(true);
    store.close();
  });
});

describe("slack kill-switch alert", () => {
  it("posts once when the switch trips and a webhook is set", async () => {
    const calls: string[] = [];
    const config = loadConfig({
      SYMBOLS: "AAPL",
      LOG_FILE: "off",
      SLACK_WEBHOOK_URL: "https://hooks.slack.test/services/xxx",
    });
    const book = emptyRiskBook();
    tripKillSwitch(book, "test trip");
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(String(input));
      expect(String(init?.body)).not.toMatch(/WALLET_PRIVATE_KEY|0x[0-9a-fA-F]{64}/);
      return { ok: true, status: 200, json: async () => ({}) } as Response;
    };
    await persistRiskSideEffects({ config, book, fetchImpl });
    expect(calls).toHaveLength(1);
    await persistRiskSideEffects({ config, book, fetchImpl });
    expect(calls).toHaveLength(1);
  });

  it("does not post when no webhook is configured", async () => {
    const config = loadConfig({ SYMBOLS: "AAPL", LOG_FILE: "off" });
    const book = emptyRiskBook();
    tripKillSwitch(book, "test trip");
    const fetchImpl: typeof fetch = async () => {
      throw new Error("should not fetch");
    };
    await persistRiskSideEffects({ config, book, fetchImpl });
  });
});

describe("file logger", () => {
  afterEach(() => closeLogger());

  it("writes JSON lines and redacts secret-looking keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "arb-logs-"));
    const path = join(dir, "bot.jsonl");
    try {
      configureLogger({ filePath: path });
      log.info("test.event", {
        symbol: "AAPL",
        slackWebhookUrl: "https://hooks.slack.test/secret",
        walletPrivateKey: "0xshouldnotappear",
      });
      const raw = readFileSync(path, "utf8");
      expect(raw).toContain("test.event");
      expect(raw).toContain("AAPL");
      expect(raw).toContain("[redacted]");
      expect(raw).not.toContain("0xshouldnotappear");
      expect(raw).not.toContain("hooks.slack.test/secret");
    } finally {
      closeLogger();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
