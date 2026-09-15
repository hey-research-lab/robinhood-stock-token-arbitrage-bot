import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { fetchRestReferencePrice } from "../src/marketdata/rest/prices.js";
import { parseDecimalToScaled } from "../src/normalize/units.js";
import type { RegisteredAsset } from "../src/domain/asset.js";
import { StalePriceError } from "../src/domain/errors.js";

const asset: RegisteredAsset = {
  id: "0xabc",
  tokenSymbol: "AAPL",
  tokenName: "Apple",
  status: "ASSET_STATUS_ACTIVE",
  currentMultiplier: "1.05",
  pendingMultiplier: "",
  deployment: {
    contractAddress: getAddress("0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9"),
    chainId: 4663,
  },
};

describe("REST reference collector", () => {
  it("converts share bid/ask into token USD using the supplied multiplier", async () => {
    const generatedAt = new Date("2026-09-15T12:00:00.000Z");
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          quotes: [
            {
              tokenSymbol: "AAPL",
              bid: "100",
              ask: "101",
              currency: "USD",
              isTradingHalt: false,
              generatedAt: generatedAt.toISOString(),
            },
          ],
        }),
        { status: 200 },
      );

    const quote = await fetchRestReferencePrice(
      asset,
      parseDecimalToScaled("1.05"),
      20_000,
      fetchImpl,
      generatedAt.getTime() + 1_000,
    );

    expect(quote.bidTokenUsd.valueUsd).toBe("105");
    expect(quote.askTokenUsd.valueUsd).toBe("106.05");
    expect(quote.bidTokenUsd.meta?.restNotMultiplierAdjusted).toBe(true);
  });

  it("rejects a REST quote past the max age", async () => {
    const generatedAt = new Date("2026-09-15T12:00:00.000Z");
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          tokenSymbol: "AAPL",
          bid: "100",
          ask: "101",
          generatedAt: generatedAt.toISOString(),
        }),
        { status: 200 },
      );

    await expect(
      fetchRestReferencePrice(
        asset,
        parseDecimalToScaled("1"),
        20_000,
        fetchImpl,
        generatedAt.getTime() + 21_000,
      ),
    ).rejects.toBeInstanceOf(StalePriceError);
  });
});
