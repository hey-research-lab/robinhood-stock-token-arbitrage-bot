import type { Hash } from "viem";
import type { TradeRecord } from "../domain/trade.js";
import { log } from "../logging/logger.js";
import type { ReceiptLookup } from "../monitor/monitor.js";
import { isOnchainTxHash } from "../monitor/monitor.js";
import type { BotStore } from "../persistence/db.js";
import { bookFromFills } from "../positions/tracker.js";
import { tripKillSwitch } from "../risk/engine.js";
import type { RiskBook } from "../risk/types.js";
import type { TradeRegistry } from "../execution/registry.js";

export interface ReconcileMismatch {
  code: string;
  detail: string;
  opportunityId?: string;
}

export interface ReconcileReport {
  checked: number;
  reconciled: number;
  mismatches: ReconcileMismatch[];
  rebuiltPositions: boolean;
}

const EPS = 0.005;

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < EPS;
}

function reconstructionComplete(trade: TradeRecord): boolean {
  return Boolean(
    trade.symbol &&
      trade.token &&
      trade.multiplier &&
      trade.dexPriceUsd &&
      trade.fillPriceUsd &&
      trade.referencePriceUsd &&
      trade.sizeUsd > 0 &&
      trade.gasUsd &&
      trade.netEdgeUsd &&
      trade.riskCode,
  );
}

/**
 * Mark confirmed fills reconciled. Compare the risk book to recorded fills.
 * Live receipts that contradict a confirmed trade trip the kill switch.
 */
export async function reconcile(args: {
  store: BotStore;
  book: RiskBook;
  registry: TradeRegistry;
  now?: Date;
  getReceipt?: ReceiptLookup;
}): Promise<ReconcileReport> {
  const now = args.now ?? new Date();
  const mismatches: ReconcileMismatch[] = [];
  let reconciled = 0;
  const trades = args.store.listTrades();
  let checked = 0;

  for (const trade of trades) {
    if (trade.state !== "confirmed") continue;
    checked += 1;

    if (!reconstructionComplete(trade)) {
      mismatches.push({
        code: "INCOMPLETE_RECORD",
        detail: `Trade ${trade.id} is missing reconstruction fields`,
        opportunityId: trade.opportunityId,
      });
      continue;
    }

    if (trade.mode === "live" && isOnchainTxHash(trade.txHash) && args.getReceipt) {
      const status = await args.getReceipt(trade.txHash as Hash);
      if (status === "reverted") {
        mismatches.push({
          code: "RECEIPT_REVERTED",
          detail: `Confirmed live trade ${trade.id} has a reverted receipt ${trade.txHash}`,
          opportunityId: trade.opportunityId,
        });
        tripKillSwitch(
          args.book,
          `Reconcile: confirmed trade ${trade.id} receipt reverted (${trade.txHash})`,
        );
        continue;
      }
      if (status === "unknown") {
        mismatches.push({
          code: "RECEIPT_MISSING",
          detail: `Confirmed live trade ${trade.id} has no receipt yet`,
          opportunityId: trade.opportunityId,
        });
        continue;
      }
    }

    args.registry.update(trade.opportunityId, {
      state: "reconciled",
      at: now,
      reconciledAt: now,
    });
    reconciled += 1;
  }

  const fills = args.store.listTrades().filter((t) => t.fillRecorded);
  const derived = bookFromFills(fills, now);
  let rebuiltPositions = false;

  const symbols = new Set([
    ...Object.keys(args.book.positionsUsdBySymbol),
    ...Object.keys(derived.positionsUsdBySymbol),
  ]);
  for (const symbol of symbols) {
    const have = args.book.positionsUsdBySymbol[symbol] ?? 0;
    const want = derived.positionsUsdBySymbol[symbol] ?? 0;
    if (!nearlyEqual(have, want)) {
      mismatches.push({
        code: "POSITION_MISMATCH",
        detail: `${symbol} book ${have} USD vs fills ${want} USD; rebuilding from fills`,
      });
      rebuiltPositions = true;
    }
  }
  if (!nearlyEqual(args.book.dailyPnlUsd, derived.dailyPnlUsd)) {
    mismatches.push({
      code: "PNL_MISMATCH",
      detail: `daily PnL book ${args.book.dailyPnlUsd} vs fills ${derived.dailyPnlUsd}; rebuilding from fills`,
    });
    rebuiltPositions = true;
  }

  if (rebuiltPositions) {
    args.book.positionsUsdBySymbol = derived.positionsUsdBySymbol;
    args.book.dailyPnlUsd = derived.dailyPnlUsd;
  }

  args.store.saveRiskBook(args.book, now);
  log.info("reconcile.complete", {
    checked,
    reconciled,
    mismatchCount: mismatches.length,
    rebuiltPositions,
    killSwitchTripped: args.book.killSwitchTripped,
  });
  for (const mismatch of mismatches) {
    log.error("reconcile.mismatch", { ...mismatch });
  }
  return { checked, reconciled, mismatches, rebuiltPositions };
}
