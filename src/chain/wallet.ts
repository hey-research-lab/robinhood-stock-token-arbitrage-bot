import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  createPublicClient,
  createWalletClient,
  http,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { ExecutionError } from "../domain/errors.js";
import { createRobinhoodPublicClient, robinhoodChain } from "./client.js";
import type { SwapBroadcast } from "../execution/types.js";

const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

export function readWalletPrivateKey(env: NodeJS.ProcessEnv = process.env): Hex {
  if (env.WALLET_KMS_REF?.trim() && !env.WALLET_PRIVATE_KEY?.trim()) {
    throw new ExecutionError(
      "WALLET_KMS_REF is set but KMS signing is not implemented in Phase 4. Use WALLET_PRIVATE_KEY locally and never commit it.",
    );
  }
  const key = env.WALLET_PRIVATE_KEY?.trim();
  if (!key) {
    throw new ExecutionError(
      "LIVE_TRADING=true requires WALLET_PRIVATE_KEY in the environment. Never commit the key.",
    );
  }
  if (!KEY_RE.test(key)) {
    throw new ExecutionError("WALLET_PRIVATE_KEY must be 0x-prefixed 32-byte hex");
  }
  return key as Hex;
}

export interface RobinhoodWallet {
  account: PrivateKeyAccount;
  chain: Chain;
  publicClient: PublicClient;
  walletClient: WalletClient;
}

export function createRobinhoodWallet(rpcUrl: string, privateKey: Hex): RobinhoodWallet {
  const trimmed = rpcUrl.trim();
  if (!trimmed) {
    throw new ExecutionError("ROBINHOOD_RPC_URL is required for live execution. There is no bundled public RPC.");
  }
  const account = privateKeyToAccount(privateKey);
  const chain = robinhoodChain(trimmed);
  return {
    account,
    chain,
    publicClient: createPublicClient({ chain, transport: http(trimmed) }),
    walletClient: createWalletClient({ account, chain, transport: http(trimmed) }),
  };
}

export function viemSwapBroadcast(wallet: RobinhoodWallet): SwapBroadcast {
  return {
    address: wallet.account.address,
    async send(tx) {
      const hash = await wallet.walletClient.sendTransaction({
        account: wallet.account,
        chain: wallet.chain,
        to: tx.to,
        data: tx.data,
        value: tx.value,
        ...(tx.gas !== undefined ? { gas: tx.gas } : {}),
      });
      return { hash };
    },
    async wait(hash) {
      const receipt = await wallet.publicClient.waitForTransactionReceipt({ hash });
      return { status: receipt.status === "success" ? "success" : "reverted" };
    },
  };
}

export function requireRpcForLive(rpcUrl: string | undefined): string {
  const trimmed = rpcUrl?.trim();
  if (!trimmed) {
    throw new ExecutionError("LIVE_TRADING=true requires ROBINHOOD_RPC_URL. There is no bundled public RPC.");
  }
  createRobinhoodPublicClient(trimmed);
  return trimmed;
}
