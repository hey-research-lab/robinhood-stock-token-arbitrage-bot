import type { Hash, PublicClient } from "viem";
import type { TradeRecord } from "../domain/trade.js";
import { log } from "../logging/logger.js";
import type { BotStore } from "../persistence/db.js";
import { recordFill } from "../risk/engine.js";
import type { RiskBook } from "../risk/types.js";
import type { TradeRegistry } from "../execution/registry.js";

export type ReceiptStatus = "success" | "reverted" | "unknown";

export type ReceiptLookup = (hash: Hash) => Promise<ReceiptStatus>;

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export function isOnchainTxHash(hash: string | undefined): hash is Hash {
  return Boolean(hash && HASH_RE.test(hash));
}

export function createReceiptLookup(client: PublicClient): ReceiptLookup {
  return async (hash) => {
    try {
      const receipt = await client.getTransactionReceipt({ hash });
      return receipt.status === "success" ? "success" : "reverted";
    } catch {
      return "unknown";
    }
  };
}

function ageMs(trade: TradeRecord, now: Date): number {
  const start = trade.submittedAt ?? trade.pendingAt ?? trade.detectedAt;
  return now.getTime() - start.getTime();
}

/**
 * Advance live trades that are submitted/pending. Paper hashes are ignored.
 * Records a fill only on first confirmation.
 */
export async function monitorPendingTrades(args: {
  store: BotStore;
  book: RiskBook;
  registry: TradeRegistry;
  getReceipt: ReceiptLookup;
  now?: Date;
  pendingTimeoutMs: number;
}): Promise<{ confirmed: number; failed: number; stillPending: number; skipped: number }> {
  const now = args.now ?? new Date();
  let confirmed = 0;
  let failed = 0;
  let stillPending = 0;
  let skipped = 0;

  for (const trade of args.store.listPendingLive()) {
    if (!isOnchainTxHash(trade.txHash)) {
      skipped += 1;
      log.warn("monitor.skipped_non_onchain_hash", {
        id: trade.id,
        opportunityId: trade.opportunityId,
        txHash: trade.txHash ?? null,
      });
      continue;
    }

    const status = await args.getReceipt(trade.txHash);
    if (status === "unknown") {
      if (ageMs(trade, now) > args.pendingTimeoutMs) {
        args.registry.update(trade.opportunityId, {
          state: "failed",
          at: now,
          failedAt: now,
          failureReason: `No receipt after ${args.pendingTimeoutMs}ms; treating as failed to avoid a stuck pending fill`,
        });
        failed += 1;
        log.error("monitor.timeout", {
          id: trade.id,
          txHash: trade.txHash,
          pendingTimeoutMs: args.pendingTimeoutMs,
        });
        continue;
      }
      stillPending += 1;
      continue;
    }

    if (status === "reverted") {
      args.registry.update(trade.opportunityId, {
        state: "failed",
        at: now,
        failedAt: now,
        failureReason: `Transaction reverted (${trade.txHash})`,
      });
      failed += 1;
      log.error("monitor.reverted", { id: trade.id, txHash: trade.txHash });
      continue;
    }

    const current = args.registry.getByOpportunityId(trade.opportunityId) ?? trade;
    if (!current.fillRecorded) {
      recordFill(args.book, {
        symbol: current.symbol,
        signedNotionalUsd: current.signedNotionalUsd,
        realizedPnlUsd: Number(current.realizedPnlUsd),
      });
    }
    args.registry.update(trade.opportunityId, {
      state: "confirmed",
      at: now,
      confirmedAt: now,
      fillRecorded: true,
      txHash: current.txHash,
    });
    confirmed += 1;
    log.info("monitor.confirmed", {
      id: current.id,
      opportunityId: current.opportunityId,
      txHash: current.txHash,
      fillRecorded: true,
    });
  }

  args.store.saveRiskBook(args.book, now);
  return { confirmed, failed, stillPending, skipped };
}

export { monitorPendingTrades as monitorTransaction };
