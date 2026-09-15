import type { Address, PublicClient } from "viem";
import { aggregatorV3Abi } from "../../chain/abis.js";
import { assertFresh, type Price } from "../../domain/price.js";
import { chainlinkAnswerToTokenUsd, makePrice } from "../../normalize/units.js";

export interface ChainlinkRead {
  feed: Address;
  decimals: number;
  description?: string;
  roundId: bigint;
  answer: bigint;
  updatedAt: Date;
  price: Price;
  oraclePaused?: boolean;
}

export async function readChainlinkTokenPrice(args: {
  client: PublicClient;
  feed: Address;
  symbol: string;
  multiplier: bigint;
  maxAgeMs: number;
  oraclePaused?: boolean;
  now?: number;
}): Promise<ChainlinkRead> {
  const [roundId, answer, , updatedAt] = await args.client.readContract({
    address: args.feed,
    abi: aggregatorV3Abi,
    functionName: "latestRoundData",
  });
  const decimals = await args.client.readContract({
    address: args.feed,
    abi: aggregatorV3Abi,
    functionName: "decimals",
  });

  let description: string | undefined;
  try {
    description = await args.client.readContract({
      address: args.feed,
      abi: aggregatorV3Abi,
      functionName: "description",
    });
  } catch {
    // optional
  }

  if (answer <= 0n) {
    throw new Error(`Chainlink answer for ${args.symbol} is not positive`);
  }
  if (args.oraclePaused) {
    throw new Error(
      `oraclePaused() is true for ${args.symbol}; treat the Chainlink price as unavailable`,
    );
  }

  const timestamp = new Date(Number(updatedAt) * 1000);
  const price = makePrice({
    symbol: args.symbol,
    source: "chainlink",
    timestamp,
    multiplier: args.multiplier,
    side: "mid",
    valueUsdScaled: chainlinkAnswerToTokenUsd(answer, Number(decimals)),
    meta: {
      feed: args.feed,
      decimals: Number(decimals),
      roundId: roundId.toString(),
      chainlinkAlreadyMultiplierAdjusted: true,
      description,
    },
  });

  assertFresh(price, args.maxAgeMs, args.now ?? Date.now());

  return {
    feed: args.feed,
    decimals: Number(decimals),
    description,
    roundId,
    answer,
    updatedAt: timestamp,
    price,
    oraclePaused: args.oraclePaused,
  };
}
