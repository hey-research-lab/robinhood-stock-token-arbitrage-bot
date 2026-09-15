import { describe, expect, it } from "vitest";
import { VERIFIED_USDG } from "../src/config/constants.js";
import { loadConfig } from "../src/config/env.js";

describe("config", () => {
  it("defaults LIVE_TRADING to false when unset", () => {
    const config = loadConfig({
      SYMBOLS: "AAPL",
    });
    expect(config.liveTrading).toBe(false);
    expect(config.eligiblePerson).toBe(false);
  });

  it("does not invent an RPC URL", () => {
    const config = loadConfig({ SYMBOLS: "AAPL" });
    expect(config.rpcUrl).toBeUndefined();
  });

  it("uses the Blockscout-verified USDG address by default", () => {
    const config = loadConfig({ SYMBOLS: "AAPL,NVDA" });
    expect(config.quoteToken.address).toBe(VERIFIED_USDG.address);
    expect(config.quoteToken.decimals).toBe(6);
    expect(config.symbols).toEqual(["AAPL", "NVDA"]);
  });

  it("only enables live trading on an explicit true", () => {
    expect(loadConfig({ LIVE_TRADING: "true", SYMBOLS: "AAPL" }).liveTrading).toBe(true);
    expect(loadConfig({ LIVE_TRADING: "false", SYMBOLS: "AAPL" }).liveTrading).toBe(false);
  });

  it("defaults opportunity TTL, min USD edge, and non-zero gas fallback", () => {
    const config = loadConfig({ SYMBOLS: "AAPL" });
    expect(config.opportunityTtlMs).toBe(5000);
    expect(config.minNetEdgeUsd).toBe(0.5);
    expect(config.estimatedGasUsd).toBe(0.05);
    expect(config.uniswapApiKey).toBeUndefined();
    expect(config.walletPrivateKeyConfigured).toBe(false);
    expect(config.sqlitePath).toBe("./data/bot.sqlite");
    expect(config.logFile).toBe("./logs/bot.jsonl");
    expect(config.slackWebhookUrl).toBeUndefined();
    expect(config.pendingTxTimeoutMs).toBe(900_000);
  });
});
