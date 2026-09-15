import { createPublicClient, defineChain, http, type PublicClient } from "viem";
import { ROBINHOOD_CHAIN_ID } from "../config/constants.js";

export function robinhoodChain(rpcUrl: string) {
  return defineChain({
    id: ROBINHOOD_CHAIN_ID,
    name: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: {
      default: { http: [rpcUrl] },
    },
  });
}

export function createRobinhoodPublicClient(rpcUrl: string): PublicClient {
  const trimmed = rpcUrl.trim();
  if (!trimmed) {
    throw new Error(
      "ROBINHOOD_RPC_URL is required for onchain reads. There is no bundled public RPC — paste your Chainstack, QuickNode, or Dwellir endpoint into .env.",
    );
  }
  return createPublicClient({
    chain: robinhoodChain(trimmed),
    transport: http(trimmed),
  });
}
