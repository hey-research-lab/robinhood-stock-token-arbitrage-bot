import type { PublicClient } from "viem";
import { STOCK_TOKEN_DECIMALS } from "../config/constants.js";
import type { AppConfig } from "../config/env.js";
import type { RegisteredAsset } from "../domain/asset.js";
import type { Price } from "../domain/price.js";
import { log } from "../logging/logger.js";
import { createUniswapAdapter } from "./dex/uniswap.js";
import type { DexQuote } from "./dex/types.js";
import { readChainlinkTokenPrice } from "./onchain/chainlink.js";
import {
  readOnchainMultiplier,
  registryMultiplierFallback,
  type OnchainMultiplier,
} from "./onchain/multiplier.js";
import { fetchRestReferencePrice, type RestQuote } from "./rest/prices.js";

export interface SymbolSnapshot {
  symbol: string;
  assetStatus: string;
  token: string;
  multiplier: string;
  multiplierSource: "onchain_uiMultiplier" | "registry_currentMultiplier";
  oraclePaused?: boolean;
  isTradingHalt: boolean;
  rest?: RestQuote;
  chainlink?: Price;
  dexQuotes: DexQuote[];
  /** @deprecated use dexQuotes */
  dexStub?: DexQuote;
  errors: string[];
}

export async function collectSymbol(args: {
  config: AppConfig;
  asset: RegisteredAsset;
  client?: PublicClient;
}): Promise<SymbolSnapshot> {
  const { config, asset, client } = args;
  const errors: string[] = [];
  let onchain: OnchainMultiplier | undefined;

  if (client) {
    try {
      onchain = await readOnchainMultiplier(client, asset.deployment.contractAddress);
    } catch (err) {
      errors.push(`multiplier: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const multiplier = onchain?.uiMultiplier ?? registryMultiplierFallback(asset.currentMultiplier);
  const multiplierSource = onchain ? "onchain_uiMultiplier" : "registry_currentMultiplier";

  const snapshot: SymbolSnapshot = {
    symbol: asset.tokenSymbol,
    assetStatus: asset.status,
    token: asset.deployment.contractAddress,
    multiplier: onchain?.uiMultiplierDecimal ?? asset.currentMultiplier,
    multiplierSource,
    oraclePaused: onchain?.oraclePaused,
    isTradingHalt: false,
    dexQuotes: [],
    errors,
  };

  try {
    const rest = await fetchRestReferencePrice(asset, multiplier, config.restMaxAgeMs);
    snapshot.rest = rest;
    snapshot.isTradingHalt = rest.isTradingHalt;
  } catch (err) {
    errors.push(`rest: ${err instanceof Error ? err.message : String(err)}`);
  }

  const feed = config.chainlinkFeeds[asset.tokenSymbol];
  if (client && feed) {
    try {
      const read = await readChainlinkTokenPrice({
        client,
        feed,
        symbol: asset.tokenSymbol,
        multiplier,
        maxAgeMs: config.chainlinkMaxAgeMs,
        oraclePaused: onchain?.oraclePaused,
      });
      snapshot.chainlink = read.price;
    } catch (err) {
      errors.push(`chainlink: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (!feed) {
    errors.push(
      `chainlink: no proxy for ${asset.tokenSymbol}. Copy the address from https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood into CHAINLINK_FEED_${asset.tokenSymbol} or config/chainlink-feeds.json`,
    );
  } else if (!client) {
    errors.push("chainlink: skipped (no ROBINHOOD_RPC_URL)");
  }

  const reference =
    snapshot.rest?.askTokenUsd.valueUsdScaled ?? snapshot.chainlink?.valueUsdScaled;
  const adapter = createUniswapAdapter(config);

  if (reference === undefined) {
    errors.push("dex: no reference token price to size Uniswap quotes");
  } else {
    const baseRequest = {
      symbol: asset.tokenSymbol,
      token: asset.deployment.contractAddress,
      quoteToken: config.quoteToken.address,
      quoteTokenSymbol: config.quoteToken.symbol,
      quoteTokenDecimals: config.quoteToken.decimals,
      tokenDecimals: asset.tokenDecimals ?? STOCK_TOKEN_DECIMALS,
      sizeUsd: config.risk.maxSingleTradeUsd,
      multiplier,
      referenceTokenUsdScaled: reference,
      swapper: config.quoteSwapper,
    } as const;

    for (const side of ["buy_token", "sell_token"] as const) {
      try {
        const quote = await adapter.quote({ ...baseRequest, side });
        snapshot.dexQuotes.push(quote);
        if (quote.stub) snapshot.dexStub = quote;
      } catch (err) {
        errors.push(`uniswap_${side}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!config.uniswapApiKey) {
      errors.push("uniswap: UNISWAP_API_KEY unset; quotes are stubs and will not be treated as executable");
    }
  }

  log.info("marketdata.snapshot", serializeSnapshot(snapshot));
  return snapshot;
}

export function serializeSnapshot(snapshot: SymbolSnapshot): Record<string, unknown> {
  return {
    symbol: snapshot.symbol,
    assetStatus: snapshot.assetStatus,
    token: snapshot.token,
    multiplier: snapshot.multiplier,
    multiplierSource: snapshot.multiplierSource,
    oraclePaused: snapshot.oraclePaused ?? null,
    isTradingHalt: snapshot.isTradingHalt,
    restShareBid: snapshot.rest?.bid ?? null,
    restShareAsk: snapshot.rest?.ask ?? null,
    restTokenBidUsd: snapshot.rest?.bidTokenUsd.valueUsd ?? null,
    restTokenAskUsd: snapshot.rest?.askTokenUsd.valueUsd ?? null,
    restGeneratedAt: snapshot.rest?.generatedAt.toISOString() ?? null,
    chainlinkTokenUsd: snapshot.chainlink?.valueUsd ?? null,
    chainlinkAt: snapshot.chainlink?.timestamp.toISOString() ?? null,
    dexQuotes: snapshot.dexQuotes.map((q) => ({
      venue: q.venue,
      stub: q.stub,
      side: q.request.side,
      executableUsd: q.executable.valueUsd,
      gasUsd: q.estimatedGasUsd ?? null,
      gasSource: q.gasSource ?? null,
      routing: q.routing ?? null,
      note: q.note,
    })),
    errors: snapshot.errors,
  };
}
