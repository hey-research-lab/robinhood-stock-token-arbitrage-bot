import { randomUUID } from "node:crypto";
import { ExecutionError } from "../domain/errors.js";
import type { TradeRecord, TradeState } from "../domain/trade.js";
import type { BotStore } from "../persistence/db.js";

/**
 * Trade book. When a store is attached, claim/update are persisted so a crash
 * cannot double-submit the same opportunity (failed rows may be retried).
 */
export class TradeRegistry {
  private readonly byOpportunityId = new Map<string, TradeRecord>();
  private readonly store?: BotStore;

  constructor(store?: BotStore) {
    this.store = store;
    if (store) {
      for (const trade of store.listTrades()) {
        this.byOpportunityId.set(trade.opportunityId, trade);
      }
    }
  }

  getByOpportunityId(opportunityId: string): TradeRecord | undefined {
    return this.byOpportunityId.get(opportunityId) ?? this.store?.getTradeByOpportunityId(opportunityId);
  }

  claim(trade: TradeRecord): TradeRecord {
    const existing = this.getByOpportunityId(trade.opportunityId);
    if (existing && existing.state !== "failed") {
      throw new ExecutionError(
        `Opportunity ${trade.opportunityId} already ${existing.state}; refusing double-execute`,
      );
    }
    this.byOpportunityId.set(trade.opportunityId, trade);
    this.store?.upsertTrade(trade);
    this.store?.appendEvent(trade, trade.state, trade.states[trade.states.length - 1]?.at ?? new Date());
    return trade;
  }

  update(opportunityId: string, patch: Partial<TradeRecord> & { state: TradeState; at?: Date }): TradeRecord {
    const current = this.getByOpportunityId(opportunityId);
    if (!current) {
      throw new ExecutionError(`No trade for opportunity ${opportunityId}`);
    }
    const at = patch.at ?? new Date();
    const next: TradeRecord = {
      ...current,
      ...patch,
      states: [...current.states, { state: patch.state, at }],
    };
    this.byOpportunityId.set(opportunityId, next);
    this.store?.upsertTrade(next);
    this.store?.appendEvent(next, patch.state, at);
    return next;
  }
}

export const processTradeRegistry = new TradeRegistry();

export function newTradeId(mode: "paper" | "live"): string {
  return `${mode}:${randomUUID()}`;
}
