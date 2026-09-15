import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import {
  ROBINHOOD_CHAIN_ID,
  UNISWAP_TRADE_API_URL,
  UNISWAP_UNIVERSAL_ROUTER_4663,
} from "../config/constants.js";
import { ExecutionError } from "../domain/errors.js";
import { uniswapHeaders, isUniswapXRouting } from "../marketdata/dex/uniswap.js";

export interface SwapTransaction {
  to: Address;
  from: Address;
  data: Hex;
  value: bigint;
  chainId?: number;
  gas?: bigint;
}

/**
 * Routing-aware /swap body. Never send `permitData: null`. UniswapX permitData
 * is for local signing only and must not be posted.
 */
export function prepareSwapRequest(
  quoteResponse: Record<string, unknown>,
  signature?: string,
): Record<string, unknown> {
  const { permitData, permitTransaction, ...cleanQuote } = quoteResponse;
  const request: Record<string, unknown> = { ...cleanQuote };
  const routing = typeof quoteResponse.routing === "string" ? quoteResponse.routing : undefined;

  if (isUniswapXRouting(routing)) {
    if (signature) request.signature = signature;
    return request;
  }

  if (signature && permitData && typeof permitData === "object") {
    request.signature = signature;
    request.permitData = permitData;
  }
  return request;
}

export function validateSwapBeforeBroadcast(swap: {
  data?: string;
  to?: string;
  from?: string;
  value?: string;
  chainId?: number | string;
  gasLimit?: string;
}): SwapTransaction {
  if (!swap?.data || swap.data === "" || swap.data === "0x") {
    throw new ExecutionError("swap.data is empty - quote may have expired; refusing to broadcast");
  }
  if (!isHex(swap.data)) {
    throw new ExecutionError("swap.data is not valid hex");
  }
  if (!swap.to || !isAddress(swap.to) || !swap.from || !isAddress(swap.from)) {
    throw new ExecutionError("Invalid address in swap response");
  }

  const to = getAddress(swap.to);
  if (to !== UNISWAP_UNIVERSAL_ROUTER_4663) {
    throw new ExecutionError(
      `swap.to ${to} is not the documented Robinhood Chain Universal Router ${UNISWAP_UNIVERSAL_ROUTER_4663}`,
    );
  }

  if (swap.chainId !== undefined && Number(swap.chainId) !== ROBINHOOD_CHAIN_ID) {
    throw new ExecutionError(`swap.chainId ${swap.chainId} is not Robinhood Chain ${ROBINHOOD_CHAIN_ID}`);
  }

  return {
    to,
    from: getAddress(swap.from),
    data: swap.data,
    value: BigInt(swap.value || "0"),
    chainId: swap.chainId !== undefined ? Number(swap.chainId) : ROBINHOOD_CHAIN_ID,
    gas: swap.gasLimit ? BigInt(swap.gasLimit) : undefined,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

export async function fetchUniswapSwap(args: {
  apiKey: string;
  quoteResponse: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}): Promise<SwapTransaction> {
  const routing = typeof args.quoteResponse.routing === "string" ? args.quoteResponse.routing : undefined;
  if (isUniswapXRouting(routing)) {
    throw new ExecutionError(
      "UniswapX live orders need Permit2/order signing; Phase 4 live path only broadcasts CLASSIC Universal Router swaps",
    );
  }

  const fetchImpl = args.fetchImpl ?? fetch;
  const body = prepareSwapRequest(args.quoteResponse);
  const res = await fetchImpl(`${UNISWAP_TRADE_API_URL}/swap`, {
    method: "POST",
    headers: uniswapHeaders(args.apiKey),
    body: JSON.stringify(body),
  });
  const payload: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = asRecord(payload)?.detail ?? asRecord(payload)?.error ?? res.statusText;
    throw new ExecutionError(`Uniswap /swap failed HTTP ${res.status}: ${String(detail)}`);
  }
  const swap = asRecord(asRecord(payload)?.swap) ?? asRecord(payload);
  if (!swap) {
    throw new ExecutionError("Uniswap /swap response missing swap object");
  }
  return validateSwapBeforeBroadcast({
    data: typeof swap.data === "string" ? swap.data : undefined,
    to: typeof swap.to === "string" ? swap.to : undefined,
    from: typeof swap.from === "string" ? swap.from : undefined,
    value: typeof swap.value === "string" || typeof swap.value === "number" ? String(swap.value) : undefined,
    chainId:
      typeof swap.chainId === "number" || typeof swap.chainId === "string" ? swap.chainId : undefined,
    gasLimit:
      typeof swap.gasLimit === "string" || typeof swap.gasLimit === "number"
        ? String(swap.gasLimit)
        : undefined,
  });
}

export interface ApprovalTransaction {
  to: Address;
  data: Hex;
  value: bigint;
}

export async function fetchUniswapApproval(args: {
  apiKey: string;
  walletAddress: Address;
  token: Address;
  amount: string;
  fetchImpl?: typeof fetch;
}): Promise<ApprovalTransaction | undefined> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const res = await fetchImpl(`${UNISWAP_TRADE_API_URL}/check_approval`, {
    method: "POST",
    headers: uniswapHeaders(args.apiKey),
    body: JSON.stringify({
      walletAddress: args.walletAddress,
      token: args.token,
      amount: args.amount,
      chainId: ROBINHOOD_CHAIN_ID,
    }),
  });
  const payload: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = asRecord(payload)?.detail ?? asRecord(payload)?.error ?? res.statusText;
    throw new ExecutionError(`Uniswap /check_approval failed HTTP ${res.status}: ${String(detail)}`);
  }
  const approval = asRecord(asRecord(payload)?.approval);
  if (!approval?.data || !approval.to) return undefined;
  if (typeof approval.data !== "string" || approval.data === "" || approval.data === "0x") {
    return undefined;
  }
  if (!isHex(approval.data) || !isAddress(String(approval.to))) {
    throw new ExecutionError("Invalid approval transaction from Uniswap /check_approval");
  }
  return {
    to: getAddress(String(approval.to)),
    data: approval.data,
    value: BigInt(String(approval.value ?? "0")),
  };
}
