import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isAddress, getAddress, type Address } from "viem";
import { QUOTE_SWAPPER_DEFAULT, ROBINHOOD_CHAIN_ID, VERIFIED_USDG } from "./constants.js";

export interface QuoteTokenConfig {
  address: Address;
  symbol: string;
  decimals: number;
}

export interface RiskLimits {
  maxPositionPerSymbolUsd: number;
  maxSingleTradeUsd: number;
  maxDailyLossUsd: number;
  minNetEdgeBps: number;
  maxSlippageBps: number;
  riskBufferBps: number;
}

export interface AppConfig {
  rpcUrl: string | undefined;
  liveTrading: boolean;
  eligiblePerson: boolean;
  jurisdiction: string | undefined;
  symbols: string[];
  quoteToken: QuoteTokenConfig;
  onchainMaxAgeMs: number;
  restMaxAgeMs: number;
  chainlinkMaxAgeMs: number;
  risk: RiskLimits;
  uniswapApiKey: string | undefined;
  quoteSwapper: Address;
  opportunityTtlMs: number;
  minNetEdgeUsd: number;
  estimatedGasUsd: number;
  chainlinkFeedsFile: string;
  chainlinkFeeds: Record<string, Address>;
  sequencerUptimeFeed: Address | undefined;
  chainId: typeof ROBINHOOD_CHAIN_ID;
  /** True when WALLET_PRIVATE_KEY is set. The key itself is never stored on config. */
  walletPrivateKeyConfigured: boolean;
  /** True when WALLET_KMS_REF is set. KMS signing is not implemented in Phase 4. */
  walletKmsRefConfigured: boolean;
  sqlitePath: string;
  logFile: string | undefined;
  slackWebhookUrl: string | undefined;
  pendingTxTimeoutMs: number;
}

function parseBool(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined || raw.trim() === "") {
    return defaultValue;
  }
  const v = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off"].includes(v)) return false;
  throw new Error(`Invalid boolean: ${raw}`);
}

function parseNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return n;
}

function parseSymbols(raw: string | undefined): string[] {
  const source = raw?.trim() || "AAPL,NVDA,MSFT,AMZN,GOOGL,META,TSLA,AVGO,UNH,SPY";
  const symbols = source
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  if (symbols.length === 0) {
    throw new Error("SYMBOLS must contain at least one ticker");
  }
  return [...new Set(symbols)];
}

function parseOptionalPath(raw: string | undefined, fallback: string | undefined): string | undefined {
  if (raw === undefined) return fallback;
  const v = raw.trim();
  if (v === "" || v.toLowerCase() === "off" || v.toLowerCase() === "false") return undefined;
  return v;
}

function parseOptionalAddress(raw: string | undefined, name: string): Address | undefined {
  if (!raw || raw.trim() === "") return undefined;
  if (!isAddress(raw.trim(), { strict: false })) {
    throw new Error(`${name} is not a valid address: ${raw}`);
  }
  return getAddress(raw.trim());
}

function loadFeedsFile(path: string): Record<string, Address> {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    return {};
  }
  const parsed = JSON.parse(readFileSync(abs, "utf8")) as {
    feeds?: Record<string, string>;
  };
  const out: Record<string, Address> = {};
  for (const [symbol, value] of Object.entries(parsed.feeds ?? {})) {
    if (!value || value.trim() === "") continue;
    if (!isAddress(value, { strict: false })) {
      throw new Error(`Invalid Chainlink proxy for ${symbol} in ${path}: ${value}`);
    }
    out[symbol.toUpperCase()] = getAddress(value);
  }
  return out;
}

function loadEnvFeedOverrides(env: NodeJS.ProcessEnv): Record<string, Address> {
  const out: Record<string, Address> = {};
  const prefix = "CHAINLINK_FEED_";
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(prefix) || !value?.trim()) continue;
    const symbol = key.slice(prefix.length).toUpperCase();
    if (!isAddress(value, { strict: false })) {
      throw new Error(`${key} is not a valid address: ${value}`);
    }
    out[symbol] = getAddress(value);
  }
  return out;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const liveTrading = parseBool(env.LIVE_TRADING, false);
  const rpcUrl = env.ROBINHOOD_RPC_URL?.trim() || undefined;

  const quoteAddress =
    parseOptionalAddress(env.QUOTE_TOKEN_ADDRESS, "QUOTE_TOKEN_ADDRESS") ?? VERIFIED_USDG.address;

  const feedsFile = env.CHAINLINK_FEEDS_FILE?.trim() || "./config/chainlink-feeds.json";
  const chainlinkFeeds = {
    ...loadFeedsFile(feedsFile),
    ...loadEnvFeedOverrides(env),
  };

  return {
    rpcUrl,
    liveTrading,
    eligiblePerson: parseBool(env.ELIGIBLE_PERSON, false),
    jurisdiction: env.JURISDICTION?.trim().toUpperCase() || undefined,
    symbols: parseSymbols(env.SYMBOLS),
    quoteToken: {
      address: quoteAddress,
      symbol: env.QUOTE_TOKEN_SYMBOL?.trim() || VERIFIED_USDG.symbol,
      decimals: Number(env.QUOTE_TOKEN_DECIMALS || VERIFIED_USDG.decimals),
    },
    onchainMaxAgeMs: parseNumber(env.ONCHAIN_MAX_AGE_MS, 5_000, "ONCHAIN_MAX_AGE_MS"),
    restMaxAgeMs: parseNumber(env.REST_MAX_AGE_MS, 20_000, "REST_MAX_AGE_MS"),
    chainlinkMaxAgeMs: parseNumber(env.CHAINLINK_MAX_AGE_MS, 5_000, "CHAINLINK_MAX_AGE_MS"),
    risk: {
      maxPositionPerSymbolUsd: parseNumber(
        env.MAX_POSITION_PER_SYMBOL_USD,
        500,
        "MAX_POSITION_PER_SYMBOL_USD",
      ),
      maxSingleTradeUsd: parseNumber(env.MAX_SINGLE_TRADE_USD, 200, "MAX_SINGLE_TRADE_USD"),
      maxDailyLossUsd: parseNumber(env.MAX_DAILY_LOSS_USD, 250, "MAX_DAILY_LOSS_USD"),
      minNetEdgeBps: parseNumber(env.MIN_NET_EDGE_BPS, 50, "MIN_NET_EDGE_BPS"),
      maxSlippageBps: parseNumber(env.MAX_SLIPPAGE_BPS, 30, "MAX_SLIPPAGE_BPS"),
      riskBufferBps: parseNumber(env.RISK_BUFFER_BPS, 10, "RISK_BUFFER_BPS"),
    },
    uniswapApiKey: env.UNISWAP_API_KEY?.trim() || undefined,
    quoteSwapper:
      parseOptionalAddress(env.QUOTE_SWAPPER, "QUOTE_SWAPPER") ?? QUOTE_SWAPPER_DEFAULT,
    opportunityTtlMs: parseNumber(env.OPPORTUNITY_TTL_MS, 5_000, "OPPORTUNITY_TTL_MS"),
    minNetEdgeUsd: parseNumber(env.MIN_NET_EDGE_USD, 0.5, "MIN_NET_EDGE_USD"),
    estimatedGasUsd: parseNumber(env.ESTIMATED_GAS_USD, 0.05, "ESTIMATED_GAS_USD"),
    chainlinkFeedsFile: feedsFile,
    chainlinkFeeds,
    sequencerUptimeFeed: parseOptionalAddress(
      env.CHAINLINK_SEQUENCER_UPTIME_FEED,
      "CHAINLINK_SEQUENCER_UPTIME_FEED",
    ),
    chainId: ROBINHOOD_CHAIN_ID,
    walletPrivateKeyConfigured: Boolean(env.WALLET_PRIVATE_KEY?.trim()),
    walletKmsRefConfigured: Boolean(env.WALLET_KMS_REF?.trim()),
    sqlitePath: env.SQLITE_PATH?.trim() || "./data/bot.sqlite",
    logFile: parseOptionalPath(env.LOG_FILE, "./logs/bot.jsonl"),
    slackWebhookUrl: env.SLACK_WEBHOOK_URL?.trim() || undefined,
    pendingTxTimeoutMs: parseNumber(env.PENDING_TX_TIMEOUT_MS, 900_000, "PENDING_TX_TIMEOUT_MS"),
  };
}
