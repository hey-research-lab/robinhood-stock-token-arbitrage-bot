import { getAddress, type Address } from "viem";

export const ROBINHOOD_CHAIN_ID = 4663 as const;

export const RHJ_API_BASE = "https://api.robinhood.com/rhj";

/** ERC-8056 uiMultiplier is 1e18-scaled (1e18 = 1.0 shares per token). */
export const MULTIPLIER_SCALE = 10n ** 18n;

export const PRICE_UNIT = "usd_per_raw_token" as const;

/**
 * USDG on Robinhood Chain. Verified 2026-09-15 against
 * https://robinhoodchain.blockscout.com/api/v2/tokens/0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
 * symbol=USDG, name=Global Dollar, decimals=6, holders≈345k, transfers≈203M, reputation=ok.
 * Do not identify this token by ticker alone — lookalike USDG tokens exist on this chain.
 */
export const VERIFIED_USDG = {
  address: getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168") as Address,
  symbol: "USDG",
  decimals: 6,
  name: "Global Dollar",
} as const;

export const BLOCKED_JURISDICTIONS = ["US", "GB", "UK", "CA", "CH"] as const;

export const UNISWAP_TRADE_API_URL = "https://trade-api.gateway.uniswap.org/v1";

/** Robinhood Chain has Universal Router 2.1.1 only — 2.0 is not deployed. */
export const UNISWAP_UNIVERSAL_ROUTER_VERSION = "2.1.1" as const;

export const UNISWAP_UNIVERSAL_ROUTER_4663 = getAddress(
  "0x8876789976decbfcbbbe364623c63652db8c0904",
) as Address;

/** Quote-only swapper when no wallet is configured. Valid address, not a key. */
export const QUOTE_SWAPPER_DEFAULT = getAddress(
  "0x000000000000000000000000000000000000dEaD",
) as Address;

export const STOCK_TOKEN_DECIMALS = 18;

export const UNISWAP_AGENT_INFO = JSON.stringify({
  integration_name: "swap-integration",
  decision_origin: "autonomous",
  version: "1.5.0",
});
