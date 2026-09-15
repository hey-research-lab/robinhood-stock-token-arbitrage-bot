import { MULTIPLIER_SCALE, PRICE_UNIT } from "../config/constants.js";
import type { Price, PriceSide, PriceSource } from "../domain/price.js";

export function parseDecimalToScaled(value: string, decimals = 18): bigint {
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid decimal: ${value}`);
  }
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [wholeRaw, fracRaw = ""] = unsigned.split(".");
  const whole = wholeRaw || "0";
  const fracPadded = (fracRaw + "0".repeat(decimals)).slice(0, decimals);
  const scaled = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
  return negative ? -scaled : scaled;
}

export function formatScaled(amount: bigint, decimals = 18): string {
  const negative = amount < 0n;
  const abs = negative ? -amount : amount;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  const text = frac.length ? `${whole}.${frac}` : `${whole}`;
  return negative ? `-${text}` : text;
}

export function rescale(amount: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (fromDecimals === toDecimals) return amount;
  if (fromDecimals < toDecimals) {
    return amount * 10n ** BigInt(toDecimals - fromDecimals);
  }
  return amount / 10n ** BigInt(fromDecimals - toDecimals);
}

/**
 * REST /rhj/prices is underlying-share USD, NOT multiplier-adjusted.
 * Convert to USD per raw token: sharePrice * uiMultiplier / 1e18.
 */
export function restShareToTokenUsd(sharePrice: string, multiplier: bigint): bigint {
  const shareScaled = parseDecimalToScaled(sharePrice, 18);
  return (shareScaled * multiplier) / MULTIPLIER_SCALE;
}

/**
 * Chainlink Stock Token feeds already return USD per token (multiplier baked in).
 * Do NOT multiply by uiMultiplier again.
 */
export function chainlinkAnswerToTokenUsd(answer: bigint, feedDecimals: number): bigint {
  if (answer <= 0n) {
    throw new Error("Chainlink answer must be positive");
  }
  return rescale(answer, feedDecimals, 18);
}

export function parseMultiplierDecimal(value: string): bigint {
  return parseDecimalToScaled(value, 18);
}

export function usdNumberToScaled(usd: number): bigint {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new Error(`Invalid USD amount: ${usd}`);
  }
  return parseDecimalToScaled(usd.toFixed(8), 18);
}

export function usdNotionalToRaw(usd: number, decimals: number): bigint {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new Error(`Invalid USD amount: ${usd}`);
  }
  return parseDecimalToScaled(usd.toFixed(decimals), decimals);
}

/** Convert a USD notional into token raw units at a USD-per-token price. */
export function notionalUsdToTokenRaw(
  sizeUsdScaled: bigint,
  priceUsdScaled: bigint,
  tokenDecimals: number,
): bigint {
  if (priceUsdScaled <= 0n) {
    throw new Error("Price must be positive to size a sell");
  }
  return (sizeUsdScaled * 10n ** BigInt(tokenDecimals)) / priceUsdScaled;
}

/** Implied USD per 1 raw token from a USDG amount and a token amount. */
export function impliedUsdPerToken(args: {
  usdgAmountRaw: bigint;
  usdgDecimals: number;
  tokenAmountRaw: bigint;
  tokenDecimals: number;
}): bigint {
  if (args.tokenAmountRaw <= 0n) {
    throw new Error("Token amount must be positive");
  }
  const usdg18 = rescale(args.usdgAmountRaw, args.usdgDecimals, 18);
  const token18 = rescale(args.tokenAmountRaw, args.tokenDecimals, 18);
  return (usdg18 * 10n ** 18n) / token18;
}

export function applyBps(amountScaled: bigint, bps: number): bigint {
  if (bps < 0) throw new Error(`Invalid bps: ${bps}`);
  return (amountScaled * BigInt(Math.round(bps))) / 10000n;
}

export function edgeBps(edgeScaled: bigint, notionalScaled: bigint): number {
  if (notionalScaled <= 0n) return 0;
  return Number((edgeScaled * 10000n) / notionalScaled);
}

export function makePrice(args: {
  symbol: string;
  source: PriceSource;
  timestamp: Date;
  multiplier: bigint;
  side: PriceSide;
  valueUsdScaled: bigint;
  meta?: Record<string, unknown>;
}): Price {
  return {
    symbol: args.symbol,
    source: args.source,
    timestamp: args.timestamp,
    multiplier: args.multiplier,
    unit: PRICE_UNIT,
    side: args.side,
    valueUsdScaled: args.valueUsdScaled,
    valueUsd: formatScaled(args.valueUsdScaled),
    meta: args.meta,
  };
}
