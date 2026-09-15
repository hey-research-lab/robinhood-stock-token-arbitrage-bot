import { RHJ_API_BASE } from "../../config/constants.js";
import type { RegisteredAsset } from "../../domain/asset.js";
import { assertFresh, type Price } from "../../domain/price.js";
import { makePrice, restShareToTokenUsd } from "../../normalize/units.js";

export interface RestQuote {
  tokenSymbol: string;
  bid: string;
  ask: string;
  currency: string;
  isTradingHalt: boolean;
  generatedAt: Date;
  dailyTradingVolume?: string;
  bidTokenUsd: Price;
  askTokenUsd: Price;
}

interface PricesResponse {
  quotes?: Array<{
    tokenSymbol: string;
    bid: string;
    ask: string;
    currency?: string;
    isTradingHalt?: boolean;
    generatedAt: string;
    dailyTradingVolume?: string;
  }>;
  tokenSymbol?: string;
  bid?: string;
  ask?: string;
  currency?: string;
  isTradingHalt?: boolean;
  generatedAt?: string;
  dailyTradingVolume?: string;
}

function extractQuote(body: PricesResponse, symbol: string) {
  if (Array.isArray(body.quotes) && body.quotes.length > 0) {
    const match =
      body.quotes.find((q) => q.tokenSymbol?.toUpperCase() === symbol) ?? body.quotes[0];
    return match;
  }
  if (body.tokenSymbol || body.bid) {
    return body;
  }
  return undefined;
}

export async function fetchRestReferencePrice(
  asset: RegisteredAsset,
  multiplier: bigint,
  maxAgeMs: number,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<RestQuote> {
  const symbol = asset.tokenSymbol;
  const res = await fetchImpl(`${RHJ_API_BASE}/prices/${encodeURIComponent(symbol)}`);
  if (!res.ok) {
    throw new Error(`GET /rhj/prices/${symbol} failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as PricesResponse;
  const quote = extractQuote(body, symbol);
  if (!quote?.bid || !quote.ask || !quote.generatedAt) {
    throw new Error(`GET /rhj/prices/${symbol} returned an unexpected payload`);
  }

  const generatedAt = new Date(quote.generatedAt);
  const bidTokenUsd = makePrice({
    symbol,
    source: "rest_reference",
    timestamp: generatedAt,
    multiplier,
    side: "bid",
    valueUsdScaled: restShareToTokenUsd(quote.bid, multiplier),
    meta: {
      shareBid: quote.bid,
      shareAsk: quote.ask,
      currency: quote.currency ?? "USD",
      isTradingHalt: Boolean(quote.isTradingHalt),
      restNotMultiplierAdjusted: true,
    },
  });
  const askTokenUsd = makePrice({
    symbol,
    source: "rest_reference",
    timestamp: generatedAt,
    multiplier,
    side: "ask",
    valueUsdScaled: restShareToTokenUsd(quote.ask, multiplier),
    meta: {
      shareBid: quote.bid,
      shareAsk: quote.ask,
      currency: quote.currency ?? "USD",
      isTradingHalt: Boolean(quote.isTradingHalt),
      restNotMultiplierAdjusted: true,
    },
  });

  assertFresh(bidTokenUsd, maxAgeMs, now);

  return {
    tokenSymbol: symbol,
    bid: quote.bid,
    ask: quote.ask,
    currency: quote.currency ?? "USD",
    isTradingHalt: Boolean(quote.isTradingHalt),
    generatedAt,
    dailyTradingVolume: quote.dailyTradingVolume,
    bidTokenUsd,
    askTokenUsd,
  };
}
