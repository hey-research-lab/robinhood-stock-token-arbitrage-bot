import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ExecutionMode, TradeRecord, TradeState, TradeStateChange } from "../domain/trade.js";
import type { RiskBook } from "../risk/types.js";
import { bookFromFills } from "../positions/tracker.js";
import { utcDate } from "./time.js";

export interface TradeRow {
  opportunity_id: string;
  id: string;
  symbol: string;
  side: string;
  kind: string;
  mode: string;
  state: string;
  detected_at: string;
  expires_at: string;
  submitted_at: string | null;
  pending_at: string | null;
  confirmed_at: string | null;
  failed_at: string | null;
  reconciled_at: string | null;
  tx_hash: string | null;
  token: string;
  multiplier: string;
  size_usd: number;
  dex_price_usd: string;
  fill_price_usd: string;
  reference_price_usd: string;
  extra_fee_usd: string;
  slippage_usd: string;
  slippage_bps: number;
  gas_usd: string;
  gas_source: string;
  risk_buffer_usd: string;
  gross_edge_usd: string;
  net_edge_usd: string;
  realized_pnl_usd: string;
  signed_notional_usd: number;
  risk_code: string;
  risk_reason: string;
  failure_reason: string | null;
  fill_recorded: number;
  states_json: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS trades (
  opportunity_id TEXT PRIMARY KEY,
  id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,
  kind TEXT NOT NULL,
  mode TEXT NOT NULL,
  state TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  submitted_at TEXT,
  pending_at TEXT,
  confirmed_at TEXT,
  failed_at TEXT,
  reconciled_at TEXT,
  tx_hash TEXT,
  token TEXT NOT NULL,
  multiplier TEXT NOT NULL,
  size_usd REAL NOT NULL,
  dex_price_usd TEXT NOT NULL,
  fill_price_usd TEXT NOT NULL,
  reference_price_usd TEXT NOT NULL,
  extra_fee_usd TEXT NOT NULL,
  slippage_usd TEXT NOT NULL,
  slippage_bps INTEGER NOT NULL,
  gas_usd TEXT NOT NULL,
  gas_source TEXT NOT NULL,
  risk_buffer_usd TEXT NOT NULL,
  gross_edge_usd TEXT NOT NULL,
  net_edge_usd TEXT NOT NULL,
  realized_pnl_usd TEXT NOT NULL,
  signed_notional_usd REAL NOT NULL,
  risk_code TEXT NOT NULL,
  risk_reason TEXT NOT NULL,
  failure_reason TEXT,
  fill_recorded INTEGER NOT NULL DEFAULT 0,
  states_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trade_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opportunity_id TEXT NOT NULL,
  trade_id TEXT NOT NULL,
  state TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS positions (
  symbol TEXT PRIMARY KEY,
  signed_usd REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS risk_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  daily_pnl_usd REAL NOT NULL,
  pnl_date TEXT NOT NULL,
  kill_switch INTEGER NOT NULL,
  kill_switch_reason TEXT,
  kill_switch_alerted INTEGER NOT NULL DEFAULT 0
);
`;

function iso(d: Date | undefined): string | null {
  return d ? d.toISOString() : null;
}

function parseIso(raw: string | null | undefined): Date | undefined {
  if (!raw) return undefined;
  return new Date(raw);
}

export { utcDate } from "./time.js";

export function tradeToRow(trade: TradeRecord): TradeRow {
  return {
    opportunity_id: trade.opportunityId,
    id: trade.id,
    symbol: trade.symbol,
    side: trade.side,
    kind: trade.kind,
    mode: trade.mode,
    state: trade.state,
    detected_at: trade.detectedAt.toISOString(),
    expires_at: trade.expiresAt.toISOString(),
    submitted_at: iso(trade.submittedAt),
    pending_at: iso(trade.pendingAt),
    confirmed_at: iso(trade.confirmedAt),
    failed_at: iso(trade.failedAt),
    reconciled_at: iso(trade.reconciledAt),
    tx_hash: trade.txHash ?? null,
    token: trade.token,
    multiplier: trade.multiplier,
    size_usd: trade.sizeUsd,
    dex_price_usd: trade.dexPriceUsd,
    fill_price_usd: trade.fillPriceUsd,
    reference_price_usd: trade.referencePriceUsd,
    extra_fee_usd: trade.extraFeeUsd,
    slippage_usd: trade.slippageUsd,
    slippage_bps: trade.slippageBps,
    gas_usd: trade.gasUsd,
    gas_source: trade.gasSource,
    risk_buffer_usd: trade.riskBufferUsd,
    gross_edge_usd: trade.grossEdgeUsd,
    net_edge_usd: trade.netEdgeUsd,
    realized_pnl_usd: trade.realizedPnlUsd,
    signed_notional_usd: trade.signedNotionalUsd,
    risk_code: trade.riskCode,
    risk_reason: trade.riskReason,
    failure_reason: trade.failureReason ?? null,
    fill_recorded: trade.fillRecorded ? 1 : 0,
    states_json: JSON.stringify(trade.states),
  };
}

export function rowToTrade(row: TradeRow): TradeRecord {
  const states = JSON.parse(row.states_json) as Array<{ state: TradeState; at: string }>;
  const changes: TradeStateChange[] = states.map((s) => ({
    state: s.state,
    at: new Date(s.at),
  }));
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    symbol: row.symbol,
    side: row.side as TradeRecord["side"],
    kind: row.kind as TradeRecord["kind"],
    mode: row.mode as ExecutionMode,
    state: row.state as TradeState,
    detectedAt: new Date(row.detected_at),
    expiresAt: new Date(row.expires_at),
    submittedAt: parseIso(row.submitted_at),
    pendingAt: parseIso(row.pending_at),
    confirmedAt: parseIso(row.confirmed_at),
    failedAt: parseIso(row.failed_at),
    reconciledAt: parseIso(row.reconciled_at),
    txHash: row.tx_hash ?? undefined,
    token: row.token,
    multiplier: row.multiplier,
    sizeUsd: row.size_usd,
    dexPriceUsd: row.dex_price_usd,
    fillPriceUsd: row.fill_price_usd,
    referencePriceUsd: row.reference_price_usd,
    extraFeeUsd: row.extra_fee_usd,
    slippageUsd: row.slippage_usd,
    slippageBps: row.slippage_bps,
    gasUsd: row.gas_usd,
    gasSource: row.gas_source,
    riskBufferUsd: row.risk_buffer_usd,
    grossEdgeUsd: row.gross_edge_usd,
    netEdgeUsd: row.net_edge_usd,
    realizedPnlUsd: row.realized_pnl_usd,
    signedNotionalUsd: row.signed_notional_usd,
    riskCode: row.risk_code,
    riskReason: row.risk_reason,
    failureReason: row.failure_reason ?? undefined,
    fillRecorded: Boolean(row.fill_recorded),
    states: changes,
  };
}

export class BotStore {
  readonly path: string;
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync, path: string) {
    this.db = db;
    this.path = path;
  }

  close(): void {
    this.db.close();
  }

  upsertTrade(trade: TradeRecord): void {
    const row = tradeToRow(trade);
    this.db
      .prepare(
        `INSERT INTO trades (
          opportunity_id, id, symbol, side, kind, mode, state,
          detected_at, expires_at, submitted_at, pending_at, confirmed_at, failed_at, reconciled_at,
          tx_hash, token, multiplier, size_usd, dex_price_usd, fill_price_usd, reference_price_usd,
          extra_fee_usd, slippage_usd, slippage_bps, gas_usd, gas_source, risk_buffer_usd,
          gross_edge_usd, net_edge_usd, realized_pnl_usd, signed_notional_usd,
          risk_code, risk_reason, failure_reason, fill_recorded, states_json
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?
        )
        ON CONFLICT(opportunity_id) DO UPDATE SET
          id=excluded.id, symbol=excluded.symbol, side=excluded.side, kind=excluded.kind,
          mode=excluded.mode, state=excluded.state, detected_at=excluded.detected_at,
          expires_at=excluded.expires_at, submitted_at=excluded.submitted_at, pending_at=excluded.pending_at,
          confirmed_at=excluded.confirmed_at, failed_at=excluded.failed_at, reconciled_at=excluded.reconciled_at,
          tx_hash=excluded.tx_hash, token=excluded.token, multiplier=excluded.multiplier,
          size_usd=excluded.size_usd, dex_price_usd=excluded.dex_price_usd, fill_price_usd=excluded.fill_price_usd,
          reference_price_usd=excluded.reference_price_usd, extra_fee_usd=excluded.extra_fee_usd,
          slippage_usd=excluded.slippage_usd, slippage_bps=excluded.slippage_bps, gas_usd=excluded.gas_usd,
          gas_source=excluded.gas_source, risk_buffer_usd=excluded.risk_buffer_usd,
          gross_edge_usd=excluded.gross_edge_usd, net_edge_usd=excluded.net_edge_usd,
          realized_pnl_usd=excluded.realized_pnl_usd, signed_notional_usd=excluded.signed_notional_usd,
          risk_code=excluded.risk_code, risk_reason=excluded.risk_reason, failure_reason=excluded.failure_reason,
          fill_recorded=excluded.fill_recorded, states_json=excluded.states_json`,
      )
      .run(
        row.opportunity_id,
        row.id,
        row.symbol,
        row.side,
        row.kind,
        row.mode,
        row.state,
        row.detected_at,
        row.expires_at,
        row.submitted_at,
        row.pending_at,
        row.confirmed_at,
        row.failed_at,
        row.reconciled_at,
        row.tx_hash,
        row.token,
        row.multiplier,
        row.size_usd,
        row.dex_price_usd,
        row.fill_price_usd,
        row.reference_price_usd,
        row.extra_fee_usd,
        row.slippage_usd,
        row.slippage_bps,
        row.gas_usd,
        row.gas_source,
        row.risk_buffer_usd,
        row.gross_edge_usd,
        row.net_edge_usd,
        row.realized_pnl_usd,
        row.signed_notional_usd,
        row.risk_code,
        row.risk_reason,
        row.failure_reason,
        row.fill_recorded,
        row.states_json,
      );
  }

  appendEvent(trade: TradeRecord, state: TradeState, at: Date): void {
    this.db
      .prepare(
        `INSERT INTO trade_events (opportunity_id, trade_id, state, at) VALUES (?, ?, ?, ?)`,
      )
      .run(trade.opportunityId, trade.id, state, at.toISOString());
  }

  getTradeByOpportunityId(opportunityId: string): TradeRecord | undefined {
    const row = this.db
      .prepare(`SELECT * FROM trades WHERE opportunity_id = ?`)
      .get(opportunityId) as unknown as TradeRow | undefined;
    return row ? rowToTrade(row) : undefined;
  }

  listTrades(): TradeRecord[] {
    const rows = this.db.prepare(`SELECT * FROM trades`).all() as unknown as TradeRow[];
    return rows.map(rowToTrade);
  }

  listPendingLive(): TradeRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM trades WHERE mode = 'live' AND state IN ('submitted', 'pending')`,
      )
      .all() as unknown as TradeRow[];
    return rows.map(rowToTrade);
  }

  listUnreconciled(): TradeRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM trades WHERE state IN ('confirmed', 'failed')`)
      .all() as unknown as TradeRow[];
    return rows.map(rowToTrade);
  }

  saveRiskBook(book: RiskBook, now: Date = new Date()): void {
    this.db.exec(`DELETE FROM positions`);
    const insert = this.db.prepare(`INSERT INTO positions (symbol, signed_usd) VALUES (?, ?)`);
    for (const [symbol, signed] of Object.entries(book.positionsUsdBySymbol)) {
      insert.run(symbol, signed);
    }
    this.db
      .prepare(
        `INSERT INTO risk_state (id, daily_pnl_usd, pnl_date, kill_switch, kill_switch_reason, kill_switch_alerted)
         VALUES (1, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           daily_pnl_usd=excluded.daily_pnl_usd,
           pnl_date=excluded.pnl_date,
           kill_switch=excluded.kill_switch,
           kill_switch_reason=excluded.kill_switch_reason,
           kill_switch_alerted=excluded.kill_switch_alerted`,
      )
      .run(
        book.dailyPnlUsd,
        utcDate(now),
        book.killSwitchTripped ? 1 : 0,
        book.killSwitchReason ?? null,
        book.killSwitchAlerted ? 1 : 0,
      );
  }

  loadRiskBook(now: Date = new Date()): RiskBook {
    const fills = this.listTrades().filter((t) => t.fillRecorded);
    const derived = bookFromFills(fills, now);
    const state = this.db.prepare(`SELECT * FROM risk_state WHERE id = 1`).get() as
      | {
          kill_switch: number;
          kill_switch_reason: string | null;
          kill_switch_alerted: number;
        }
      | undefined;
    if (!state) {
      return derived;
    }
    derived.killSwitchTripped = Boolean(state.kill_switch);
    derived.killSwitchReason = state.kill_switch_reason ?? undefined;
    derived.killSwitchAlerted = Boolean(state.kill_switch_alerted);
    derived.killSwitchNeedsAlert = derived.killSwitchTripped && !derived.killSwitchAlerted;
    return derived;
  }
}

export function openDatabase(path: string): BotStore {
  const trimmed = path.trim() || "./data/bot.sqlite";
  if (trimmed !== ":memory:") {
    const abs = resolve(trimmed);
    mkdirSync(dirname(abs), { recursive: true });
    const db = new DatabaseSync(abs);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(SCHEMA);
    return new BotStore(db, abs);
  }
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  return new BotStore(db, ":memory:");
}
