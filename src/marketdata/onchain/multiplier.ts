import type { Address, PublicClient } from "viem";
import { erc8056Abi } from "../../chain/abis.js";
import { MULTIPLIER_SCALE } from "../../config/constants.js";
import { formatScaled, parseMultiplierDecimal } from "../../normalize/units.js";

export interface OnchainMultiplier {
  token: Address;
  uiMultiplier: bigint;
  uiMultiplierDecimal: string;
  newUIMultiplier?: bigint;
  effectiveAt?: bigint;
  oraclePaused?: boolean;
  blockNumber: bigint;
  blockTimestamp: Date;
}

export async function readOnchainMultiplier(
  client: PublicClient,
  token: Address,
): Promise<OnchainMultiplier> {
  const block = await client.getBlock();
  const uiMultiplier = await client.readContract({
    address: token,
    abi: erc8056Abi,
    functionName: "uiMultiplier",
  });

  let newUIMultiplier: bigint | undefined;
  let effectiveAt: bigint | undefined;
  let oraclePaused: boolean | undefined;

  try {
    newUIMultiplier = await client.readContract({
      address: token,
      abi: erc8056Abi,
      functionName: "newUIMultiplier",
    });
    effectiveAt = await client.readContract({
      address: token,
      abi: erc8056Abi,
      functionName: "effectiveAt",
    });
  } catch {
    // Pending-multiplier views are optional on some deployments.
  }

  try {
    oraclePaused = await client.readContract({
      address: token,
      abi: erc8056Abi,
      functionName: "oraclePaused",
    });
  } catch {
    // Pause flag is advisory; absence is not fatal.
  }

  if (uiMultiplier === 0n) {
    throw new Error(`uiMultiplier() returned 0 for ${token}`);
  }

  return {
    token,
    uiMultiplier,
    uiMultiplierDecimal: formatScaled(uiMultiplier),
    newUIMultiplier,
    effectiveAt,
    oraclePaused,
    blockNumber: block.number,
    blockTimestamp: new Date(Number(block.timestamp) * 1000),
  };
}

export function registryMultiplierFallback(currentMultiplier: string): bigint {
  const value = parseMultiplierDecimal(currentMultiplier);
  return value === 0n ? MULTIPLIER_SCALE : value;
}
