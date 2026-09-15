import { getAddress, isAddress } from "viem";
import { RHJ_API_BASE, ROBINHOOD_CHAIN_ID } from "../config/constants.js";
import type { RegisteredAsset } from "../domain/asset.js";

interface AssetsResponse {
  assets: Array<{
    id: string;
    tokenSymbol: string;
    tokenName: string;
    status: string;
    currentMultiplier: string;
    pendingMultiplier?: string;
    pendingMultiplierEffectiveTime?: string;
    tokenDecimals?: number;
    tradingCapabilities?: unknown;
    deployments: Array<{
      contractAddress: string;
      chainId: number;
      networkName?: string;
    }>;
  }>;
}

export async function fetchRhjAssets(fetchImpl: typeof fetch = fetch): Promise<RegisteredAsset[]> {
  const res = await fetchImpl(`${RHJ_API_BASE}/assets`);
  if (!res.ok) {
    throw new Error(`GET /rhj/assets failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as AssetsResponse;
  const assets: RegisteredAsset[] = [];
  for (const asset of body.assets ?? []) {
    const deployment = (asset.deployments ?? []).find((d) => d.chainId === ROBINHOOD_CHAIN_ID);
    if (!deployment) continue;
    if (!isAddress(deployment.contractAddress, { strict: false })) {
      throw new Error(`Invalid contract for ${asset.tokenSymbol}: ${deployment.contractAddress}`);
    }
    assets.push({
      id: asset.id,
      tokenSymbol: asset.tokenSymbol.toUpperCase(),
      tokenName: asset.tokenName,
      status: asset.status,
      currentMultiplier: asset.currentMultiplier,
      pendingMultiplier: asset.pendingMultiplier ?? "",
      pendingMultiplierEffectiveTime: asset.pendingMultiplierEffectiveTime,
      tokenDecimals: asset.tokenDecimals,
      tradingCapabilities: asset.tradingCapabilities,
      deployment: {
        contractAddress: getAddress(deployment.contractAddress),
        chainId: deployment.chainId,
        networkName: deployment.networkName,
      },
    });
  }
  return assets;
}

export function selectWatchlist(assets: RegisteredAsset[], symbols: string[]): RegisteredAsset[] {
  const bySymbol = new Map(assets.map((a) => [a.tokenSymbol, a]));
  const selected: RegisteredAsset[] = [];
  for (const symbol of symbols) {
    const asset = bySymbol.get(symbol);
    if (!asset) {
      throw new Error(
        `${symbol} is not in /rhj/assets for chain ${ROBINHOOD_CHAIN_ID}. Check the ticker against the official registry; do not guess a contract address.`,
      );
    }
    selected.push(asset);
  }
  return selected;
}
