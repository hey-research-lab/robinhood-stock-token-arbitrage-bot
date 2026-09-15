import { describe, expect, it } from "vitest";
import { StalePriceError } from "../src/domain/errors.js";
import { assertFresh, isFresh, type Price } from "../src/domain/price.js";
import { PRICE_UNIT } from "../src/config/constants.js";

function price(overrides: Partial<Price> = {}): Price {
  return {
    symbol: "AAPL",
    source: "rest_reference",
    timestamp: new Date("2026-09-15T12:00:00.000Z"),
    multiplier: 10n ** 18n,
    unit: PRICE_UNIT,
    side: "bid",
    valueUsdScaled: 200n * 10n ** 18n,
    valueUsd: "200",
    ...overrides,
  };
}

describe("price freshness", () => {
  it("rejects REST quotes older than 20s", () => {
    const quote = price({ source: "rest_reference" });
    const now = Date.parse("2026-09-15T12:00:21.000Z");
    expect(isFresh(quote, 20_000, now)).toBe(false);
    expect(() => assertFresh(quote, 20_000, now)).toThrow(StalePriceError);
  });

  it("accepts a REST quote at 19s", () => {
    const quote = price({ source: "rest_reference" });
    const now = Date.parse("2026-09-15T12:00:19.000Z");
    expect(isFresh(quote, 20_000, now)).toBe(true);
    expect(() => assertFresh(quote, 20_000, now)).not.toThrow();
  });

  it("rejects onchain data older than 5s", () => {
    const quote = price({
      source: "chainlink",
      timestamp: new Date("2026-09-15T12:00:00.000Z"),
    });
    const now = Date.parse("2026-09-15T12:00:05.001Z");
    expect(() => assertFresh(quote, 5_000, now)).toThrow(StalePriceError);
  });
});
