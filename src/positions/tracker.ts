import type { TradeRecord } from "../domain/trade.js";
import type { RiskBook } from "../risk/types.js";
import { emptyRiskBook } from "../risk/types.js";
import { utcDate } from "../persistence/time.js";

function fillDay(trade: TradeRecord): string {
  const at = trade.confirmedAt ?? trade.submittedAt ?? trade.detectedAt;
  return utcDate(at);
}

/**
 * Positions and same-UTC-day realized PnL are derived from recorded fills.
 * Kill-switch flags are not derived here.
 */
export function bookFromFills(fills: TradeRecord[], now: Date = new Date()): RiskBook {
  const book = emptyRiskBook();
  const today = utcDate(now);
  for (const trade of fills) {
    if (!trade.fillRecorded) continue;
    const current = book.positionsUsdBySymbol[trade.symbol] ?? 0;
    book.positionsUsdBySymbol[trade.symbol] = current + trade.signedNotionalUsd;
    if (fillDay(trade) === today) {
      book.dailyPnlUsd += Number(trade.realizedPnlUsd);
    }
  }
  return book;
}

export function loadPositions(store: { loadRiskBook(now?: Date): RiskBook }, now?: Date): Record<string, number> {
  return { ...store.loadRiskBook(now).positionsUsdBySymbol };
}
