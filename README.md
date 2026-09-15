# Robinhood Stock Token Arbitrage Bot

 **Robinhood Stock Token arbitrage bot** for **Robinhood Chain** (Arbitrum Orbit L2, chain ID **4663**). It watches onchain ERC-20 **Stock Tokens** issued by Robinhood Assets (Jersey) Ltd (RHJ), compares **Uniswap** executable prices to **Chainlink** / Robinhood REST `/rhj/prices`, and paper-trades by default.

This is **not** mint/redeem arb, **not** a Robinhood app bot, and **not** the EU “Classic Stock Tokens” derivative. Secondary-market DEX only (Uniswap first; Arcus and Pleiades later once addresses/ABIs are confirmed). Quote asset is **USDG**, not WETH.

Paper mode is the default (`LIVE_TRADING` unset/false). Live Uniswap CLASSIC swaps need an explicit `LIVE_TRADING=true`, eligibility, and a pass from the risk engine.

| | This bot | Not this bot |
| --- | --- | --- |
| Asset | Onchain RHJ Stock Tokens on Robinhood Chain 4663 | Robinhood brokerage stocks, EU Classic Stock Tokens |
| Venues | Uniswap (then Arcus/Pleiades) vs Chainlink or `/rhj/prices` | CEX, other chains, create/redeem |
| Default | Paper fills, SQLite, kill switch | Silent live sends |

**Stack:** TypeScript, Node 20+, viem, Uniswap Trading API (Universal Router 2.1.1 on 4663), SQLite.

## Contents

- [Jurisdiction restriction](#jurisdiction-restriction)
- [Paper mode (default)](#paper-mode-default)
- [Setup](#setup)
- [Quote asset (USDG)](#quote-asset-usdg)
- [Price units (the easy bug)](#price-units-the-easy-bug)
- [Watchlist](#watchlist)
- [Opportunity engine (Phase 2)](#opportunity-engine-phase-2)
- [Risk engine (Phase 3)](#risk-engine-phase-3)
- [Execution (Phase 4)](#execution-phase-4)
- [Persistence, monitor, reconcile (Phase 5)](#persistence-monitor-reconcile-phase-5)
- [What is still not implemented](#what-is-still-not-implemented)

Phase 2 is a size-aware **opportunity engine** (TTL, cost model, fixture tests) and Uniswap Trading API quotes on chain 4663 when `UNISWAP_API_KEY` is set. Stub quotes are never treated as executable. Phase 3 runs every flagged opportunity through the **risk engine** (limits + kill switch). Phase 4 paper-fills allowed trades by default; live Uniswap CLASSIC swaps require `LIVE_TRADING=true`. Phase 5 persists trades and the kill switch in SQLite, monitors pending live txs, reconciles fills, writes JSON logs, and can Slack when the kill switch trips.

## Jurisdiction restriction

Stock Tokens are restricted for **US, UK, Canadian, and Swiss** persons. This repo defaults to:

```
ELIGIBLE_PERSON=false
JURISDICTION=
```

Blocked codes: `US`, `GB` (and `UK`), `CA`, `CH`.

- **Market-data collection and paper simulation may run** regardless of jurisdiction (no onchain order is sent).
- **Strategy and live execution will not start** unless `ELIGIBLE_PERSON=true` **and** `JURISDICTION` is set to a non-blocked ISO 3166-1 alpha-2 code.
- There is no silent bypass. Do not ask the bot to drop this check.

This is not legal advice. You are responsible for whether you may use Stock Tokens.

## Paper mode (default)

`LIVE_TRADING` defaults to **false**. Paper fills use quoted prices, fees, slippage, and gas, then update the in-memory risk book. Live Uniswap CLASSIC swaps only run when `LIVE_TRADING=true`, eligibility passes, risk allows, and `WALLET_PRIVATE_KEY` + RPC + `UNISWAP_API_KEY` are set. UniswapX and cross-venue live sends are refused.

Never commit `.env`. Never put a private key in source.

## Setup

1. Node.js 20+.
2. `npm install`
3. `copy .env.example .env` (Windows) or `cp .env.example .env`
4. Paste **your** `ROBINHOOD_RPC_URL` from Chainstack, QuickNode, or Dwellir. This repo **does not** ship a public RPC fallback.
5. Optional for Chainlink: copy each watchlist token’s **proxy** address from official docs into `CHAINLINK_FEED_AAPL=0x...` or `config/chainlink-feeds.json`.
   - https://docs.chain.link/data-feeds/tokenized-equity-feeds/robinhood
   - https://docs.chain.link/data-feeds/price-feeds/addresses (Robinhood network)
   - https://docs.robinhood.com/chain/oracles-and-price-feeds/
6. Optional: `UNISWAP_API_KEY` from the [Uniswap developer portal](https://developers.uniswap.org/). Without it, DEX quotes are stubs and the opportunity engine will reject them.
7. `npm test`
8. `npm start` - registry + REST (+ onchain if RPC) + Uniswap quotes + opportunity scan + risk + **paper fills**. No chain transactions unless `LIVE_TRADING=true`.

Without an RPC URL, REST still runs; onchain multiplier and Chainlink reads are skipped.

## Quote asset (USDG)

DEX quotes are denominated against **USDG**, not WETH, so v1 does not add an ETH/USD leg on top of the stock-token multiplier.

Address used (checksummed): `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`

Verified 2026-09-15 on Robinhood Blockscout:

- Token page: https://robinhoodchain.blockscout.com/token/0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168
- API: `symbol=USDG`, `name=Global Dollar`, `decimals=6`, `reputation=ok`, holders ≈ 345k, transfers ≈ 203M

Lookalike tokens named `USDG` exist on this chain. Match the **full address**, not the ticker.

## Price units (the easy bug)

Canonical unit: **USD per 1 raw ERC-20 token**.

| Source | What it returns | How this bot treats it |
| --- | --- | --- |
| `GET /rhj/prices/{symbol}` | Underlying **share** bid/ask, **not** multiplier-adjusted | Multiply by `uiMultiplier / 1e18` |
| Chainlink `latestRoundData()` | **Token** USD (multiplier already baked in) | Use as-is; **do not** multiply again |
| DEX (Uniswap Trading API) | Size-aware raw token vs USDG | Already token units; AMM fees are inside the quote |

`uiMultiplier()` is ERC-8056, 1e18-scaled. REST `currentMultiplier` from `/rhj/assets` is used only when the onchain read is unavailable.

Every `Price` object carries `source`, `timestamp`, and the `multiplier` used. Quotes older than `REST_MAX_AGE_MS` (20s) or `ONCHAIN_MAX_AGE_MS` / `CHAINLINK_MAX_AGE_MS` (5s default) are rejected.

Chainlink equity feeds are **24/5**. A 5s max age will often fail nights, weekends, and whenever the heartbeat is slower than 5s. Raise `CHAINLINK_MAX_AGE_MS` after you observe real `updatedAt` values; do not disable staleness checks.

## Watchlist

`SYMBOLS` is an explicit allowlist (default: AAPL, NVDA, MSFT, AMZN, GOOGL, META, TSLA, AVGO, UNH, SPY). Token addresses come from `GET https://api.robinhood.com/rhj/assets` for `chainId=4663`. Tickers alone are not identity.

## Opportunity engine (Phase 2)

Spreads are computed on **executable** prices at `MAX_SINGLE_TRADE_USD`, not display mids.

Net edge = gross edge − extra fees (usually 0; AMM fees are already in the Uniswap executable) − slippage − **gas** − risk buffer.

An opportunity is flagged only if net edge clears **both** `MIN_NET_EDGE_BPS` (50) and `MIN_NET_EDGE_USD` (0.50). Each opportunity has a short TTL (`OPPORTUNITY_TTL_MS`, default 5s).

Two kinds:

1. **reference_vs_onchain** - live Uniswap executable vs fresh Chainlink (preferred) or REST mid, after multiplier normalization. This is a drift signal, not mint/redeem arb.
2. **cross_venue** - buy one live DEX, sell another. Arcus/Pleiades adapters still throw until you confirm addresses/ABIs. Covered by a fixture test only.

Stub Uniswap quotes (`UNISWAP_API_KEY` empty) are logged and rejected.

Uniswap quotes follow the official `swap-integration` skill: `POST https://trade-api.gateway.uniswap.org/v1/quote`, chain ID **4663**, `x-universal-router-version: 2.1.1` (2.0 is not deployed on this chain). CLASSIC `gasFeeUSD` is used as-is; UniswapX may be gasless for the swapper; CLASSIC quotes missing gas fall back to `ESTIMATED_GAS_USD` (default $0.05, not $0).

## Risk engine (Phase 3)

The execution engine **cannot** skip this layer. Every proposed trade is allowed or vetoed, and the verdict is logged (`risk.verdict` or `risk.kill_switch`).

Checks, in order:

1. Kill switch already tripped (stays tripped until `resetKillSwitch`, even if PnL recovers)
2. Realized daily PnL ≤ `-MAX_DAILY_LOSS_USD` → trips kill switch
3. Opportunity present (no sized quote → veto)
4. Asset active; not halted (quote and live re-check)
5. Opportunity TTL not expired
6. `uiMultiplier` unchanged since the quote
7. Notional ≤ `MAX_SINGLE_TRADE_USD` ($200)
8. |position after trade| ≤ `MAX_POSITION_PER_SYMBOL_USD` ($500)
9. Quoted slippage ≤ `MAX_SLIPPAGE_BPS` (30)
10. Net edge ≥ `MIN_NET_EDGE_BPS` (50) and `MIN_NET_EDGE_USD` ($0.50)

Paper scanning and paper fills still run without eligibility. Strategy/live execution still will not start unless `ELIGIBLE_PERSON=true` and jurisdiction is not US/GB/CA/CH.

## Execution (Phase 4)

`executeTrade` always calls the risk engine first. Paper is the default:

1. **Paper** (`LIVE_TRADING` unset/false) - simulate fill at the quoted executable, worse by `MAX_SLIPPAGE_BPS`, subtract modeled fees/gas/buffer, mark `submitted` → `pending` → `confirmed`, `recordFill` on the in-memory book. `txHash` is `paper:<opportunityId>`. No `sendTransaction`.
2. **Live** (`LIVE_TRADING=true`) - eligibility required. Re-quote Uniswap, refuse if the executable moved more than max slippage, `POST /check_approval` then `POST /swap` with Universal Router **2.1.1** on chain **4663**, validate `swap.to` is the documented router, broadcast, then wait for the receipt. `submitted` (hash) is distinct from `confirmed`/`failed`. Fills are recorded only on success.

Live `reference_vs_onchain` is a **single Uniswap swap vs USDG**, not mint/redeem and not a locked two-leg arb. Cross-venue live is refused until Arcus/Pleiades are wired. UniswapX live is refused (needs Permit2/order signing).

Never commit `WALLET_PRIVATE_KEY`.

## Persistence, monitor, reconcile (Phase 5)

SQLite (`SQLITE_PATH`, default `./data/bot.sqlite`) is the source of truth for opportunity-id claims, so a crash cannot double-submit. Failed trades may be retried; anything past `submitted` may not.

On startup the CLI:

1. Loads the risk book from recorded fills (UTC-day PnL) plus persisted kill-switch
2. Monitors live `submitted`/`pending` hashes (needs `ROBINHOOD_RPC_URL`; no public fallback)
3. Reconciles confirmed trades (`confirmed` → `reconciled`) and rebuilds positions if they drift from fills
4. Then scans and paper-fills as before

JSON lines also go to `LOG_FILE` (default `./logs/bot.jsonl`; set `LOG_FILE=off` to disable). Optional `SLACK_WEBHOOK_URL` fires once when the kill switch newly trips. The webhook URL is never logged.

Pending live txs without a receipt after `PENDING_TX_TIMEOUT_MS` (default 15m) are marked failed, not confirmed. Fills are recorded only on first confirmation.

## What is still not implemented

- Arcus/Pleiades live quotes (addresses/ABIs not confirmed).
- UniswapX live orders and Permit2/KMS signing.
- Unofficial Chainlink directory fetches. Fill proxies from official docs.

## Risk placeholders (not advice)

These only scaffold config until paper data exists:

- Max position / symbol: $500
- Max single trade: $200
- Max daily loss / kill switch: $250
- Min net edge: 50 bps

The risk engine can veto a trade the strategy wants. Execution always calls it first.

## Layout

```
src/
  config/          env, chain constants, verified USDG
  eligibility/     US/GB/CA/CH blocklist
  domain/          Price, asset, trade lifecycle types
  chain/           viem client (4663), known ABIs only
  registry/        /rhj/assets
  marketdata/      REST, multiplier, Chainlink, DEX adapters
  normalize/       share vs token unit conversion
  opportunity/     cost model, TTL, reference-vs-onchain + cross-venue
  risk/            limits, kill switch, logged allow/deny
  execution/       paper simulator + live Uniswap path (cannot bypass risk)
  strategy/        eligibility-gated loop (not started from paper CLI)
  persistence/     SQLite trades, events, kill-switch
  monitor/         pending live receipts vs submitted/confirmed
  positions/       book rebuilt from recorded fills
  reconcile/       confirmed → reconciled, mismatch rebuild
  alerts/          optional Slack on kill-switch
  logging/         stdout + JSONL file
```

## Commands

```
npm test
npm start
npm run typecheck
```

