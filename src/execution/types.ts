import type { Address, Hash, Hex } from "viem";

export interface SwapBroadcast {
  address: Address;
  send(tx: { to: Address; data: Hex; value: bigint; gas?: bigint }): Promise<{ hash: Hash }>;
  wait(hash: Hash): Promise<{ status: "success" | "reverted" }>;
}
