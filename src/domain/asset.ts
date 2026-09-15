import type { Address } from "viem";

export type AssetStatus =
  | "ASSET_STATUS_UNSPECIFIED"
  | "ASSET_STATUS_ACTIVE"
  | "ASSET_STATUS_INACTIVE"
  | string;

export interface AssetDeployment {
  contractAddress: Address;
  chainId: number;
  networkName?: string;
}

export interface RegisteredAsset {
  id: string;
  tokenSymbol: string;
  tokenName: string;
  status: AssetStatus;
  currentMultiplier: string;
  pendingMultiplier: string;
  pendingMultiplierEffectiveTime?: string;
  tokenDecimals?: number;
  deployment: AssetDeployment;
  tradingCapabilities?: unknown;
}
