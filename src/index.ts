import "dotenv/config";
import { createRobinhoodPublicClient } from "./chain/client.js";
import { VERIFIED_USDG } from "./config/constants.js";
import { loadConfig } from "./config/env.js";
import { evaluateEligibility } from "./eligibility/check.js";
import { executeTrade } from "./execution/engine.js";
import { TradeRegistry } from "./execution/registry.js";
import { closeLogger, configureLogger, log } from "./logging/logger.js";
import { collectSymbol } from "./marketdata/collect.js";
import { createReceiptLookup, monitorPendingTrades } from "./monitor/monitor.js";
import { findOpportunities } from "./opportunity/engine.js";
import { persistRiskSideEffects } from "./risk/side-effects.js";
import { evaluateRisk } from "./risk/engine.js";
import { parseDecimalToScaled } from "./normalize/units.js";
import { openDatabase } from "./persistence/db.js";
import { loadPositions } from "./positions/tracker.js";
import { reconcile } from "./reconcile/job.js";
import { fetchRhjAssets, selectWatchlist } from "./registry/assets.js";

async function main(): Promise<void> {
  const config = loadConfig();
  configureLogger({ filePath: config.logFile });
  const store = openDatabase(config.sqlitePath);
  const registry = new TradeRegistry(store);
  const book = store.loadRiskBook();
  const eligibility = evaluateEligibility(config);

  log.info("bot.start", {
    phase: 5,
    chainId: config.chainId,
    liveTrading: config.liveTrading,
    paperMode: !config.liveTrading,
    symbols: config.symbols,
    quoteToken: config.quoteToken,
    usdgVerifiedAddress: VERIFIED_USDG.address,
    uniswapApiConfigured: Boolean(config.uniswapApiKey),
    walletPrivateKeyConfigured: config.walletPrivateKeyConfigured,
    sqlitePath: store.path,
    logFile: config.logFile ?? null,
    slackConfigured: Boolean(config.slackWebhookUrl),
    opportunityTtlMs: config.opportunityTtlMs,
    minNetEdgeBps: config.risk.minNetEdgeBps,
    minNetEdgeUsd: config.minNetEdgeUsd,
    estimatedGasUsd: config.estimatedGasUsd,
    pendingTxTimeoutMs: config.pendingTxTimeoutMs,
    eligibility: {
      allowedForExecution: eligibility.allowedForExecution,
      blocked: eligibility.blocked,
      reason: eligibility.reason,
      jurisdiction: eligibility.jurisdiction ?? null,
    },
    rpcConfigured: Boolean(config.rpcUrl),
    restoredKillSwitch: book.killSwitchTripped,
    restoredDailyPnlUsd: book.dailyPnlUsd,
    restoredPositions: loadPositions(store),
  });

  try {
    if (config.liveTrading && !eligibility.allowedForExecution) {
      log.error("live_trading.blocked_by_eligibility", {
        reason: eligibility.reason,
        note: "LIVE_TRADING=true will not paper-fill as a substitute. Market-data collection still runs.",
      });
    } else if (!eligibility.allowedForExecution) {
      log.warn("eligibility.execution_gated", {
        reason: eligibility.reason,
        note: "Market-data collection and paper fills continue. Strategy/live execution will not start.",
      });
    }

    const liveReady =
      config.liveTrading &&
      eligibility.allowedForExecution &&
      Boolean(config.rpcUrl) &&
      Boolean(config.uniswapApiKey) &&
      config.walletPrivateKeyConfigured;

    if (config.liveTrading && eligibility.allowedForExecution && !liveReady) {
      log.error("live_trading.misconfigured", {
        rpcConfigured: Boolean(config.rpcUrl),
        uniswapApiConfigured: Boolean(config.uniswapApiKey),
        walletPrivateKeyConfigured: config.walletPrivateKeyConfigured,
        walletKmsRefConfigured: config.walletKmsRefConfigured,
        reason:
          "LIVE_TRADING=true needs ROBINHOOD_RPC_URL, UNISWAP_API_KEY, and WALLET_PRIVATE_KEY. KMS refs are not implemented. No transaction will be sent.",
      });
    }

    if (!config.rpcUrl) {
      log.warn("rpc.missing", {
        reason:
          "ROBINHOOD_RPC_URL is empty. REST registry/prices still run; onchain multiplier and Chainlink reads are skipped. No public RPC fallback exists.",
      });
    }

    if (!config.uniswapApiKey) {
      log.warn("uniswap.api_key_missing", {
        reason:
          "UNISWAP_API_KEY is empty. Uniswap quotes are stubs and the opportunity engine will not treat them as executable.",
      });
    }

    const client = config.rpcUrl ? createRobinhoodPublicClient(config.rpcUrl) : undefined;
    const getReceipt = client ? createReceiptLookup(client) : undefined;
    const pendingLive = store.listPendingLive();
    if (pendingLive.length > 0 && getReceipt) {
      const monitored = await monitorPendingTrades({
        store,
        book,
        registry,
        getReceipt,
        pendingTimeoutMs: config.pendingTxTimeoutMs,
      });
      log.info("monitor.startup", monitored);
    } else if (pendingLive.length > 0) {
      log.warn("monitor.skipped_no_rpc", {
        pending: pendingLive.length,
        reason: "Live pending trades exist but ROBINHOOD_RPC_URL is empty; not inventing a public RPC.",
      });
    }

    const startupReconcile = await reconcile({
      store,
      book,
      registry,
      getReceipt,
    });
    log.info("reconcile.startup", {
      checked: startupReconcile.checked,
      reconciled: startupReconcile.reconciled,
      mismatchCount: startupReconcile.mismatches.length,
    });
    await persistRiskSideEffects({ config, book, store });

    const assets = await fetchRhjAssets();
    const watchlist = selectWatchlist(assets, config.symbols);

    const snapshots = [];
    for (const asset of watchlist) {
      snapshots.push(await collectSymbol({ config, asset, client }));
    }

    const scan = findOpportunities({ snapshots, config });
    let riskAllowed = 0;
    let riskVetoed = 0;
    let fills = 0;
    let fillErrors = 0;

    for (const opportunity of scan.opportunities) {
      const snapshot = snapshots.find((row) => row.symbol === opportunity.symbol);
      const liveContext = {
        currentMultiplier: snapshot ? parseDecimalToScaled(snapshot.multiplier) : undefined,
        currentAssetStatus: snapshot?.assetStatus,
        currentHalt: snapshot?.isTradingHalt,
      };
      const verdict = evaluateRisk(config, {
        opportunity,
        book,
        ...liveContext,
      });
      await persistRiskSideEffects({ config, book, store });
      if (!verdict.allowed) {
        riskVetoed += 1;
        continue;
      }
      riskAllowed += 1;

      if (config.liveTrading && !liveReady) {
        log.warn("execution.skipped_live", {
          opportunityId: opportunity.id,
          symbol: opportunity.symbol,
          reason: eligibility.allowedForExecution ? "live path is misconfigured" : eligibility.reason,
        });
        continue;
      }

      try {
        const trade = await executeTrade({
          config,
          eligibility,
          opportunity,
          book,
          registry,
          store,
          ...liveContext,
        });
        fills += 1;
        log.info("execution.reconstruct", {
          id: trade.id,
          opportunityId: trade.opportunityId,
          mode: trade.mode,
          state: trade.state,
          symbol: trade.symbol,
          side: trade.side,
          kind: trade.kind,
          token: trade.token,
          multiplier: trade.multiplier,
          sizeUsd: trade.sizeUsd,
          dexPriceUsd: trade.dexPriceUsd,
          fillPriceUsd: trade.fillPriceUsd,
          referencePriceUsd: trade.referencePriceUsd,
          extraFeeUsd: trade.extraFeeUsd,
          slippageUsd: trade.slippageUsd,
          gasUsd: trade.gasUsd,
          netEdgeUsd: trade.netEdgeUsd,
          realizedPnlUsd: trade.realizedPnlUsd,
          riskCode: trade.riskCode,
          txHash: trade.txHash ?? null,
        });
      } catch (err) {
        fillErrors += 1;
        log.error("execution.error", {
          opportunityId: opportunity.id,
          symbol: opportunity.symbol,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const closing = await reconcile({ store, book, registry, getReceipt });

    log.info("opportunity.scan_complete", {
      symbols: snapshots.length,
      opportunities: scan.opportunities.length,
      rejections: scan.rejections.length,
      riskAllowed,
      riskVetoed,
      fills,
      fillErrors,
      killSwitchTripped: book.killSwitchTripped,
      dailyPnlUsd: book.dailyPnlUsd,
      reconciled: closing.reconciled,
    });

    log.info("bot.done", {
      symbols: watchlist.length,
      phase: 5,
    });
  } finally {
    store.close();
    closeLogger();
  }
}

main().catch((err) => {
  log.error("bot.fatal", {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  closeLogger();
  process.exitCode = 1;
});
