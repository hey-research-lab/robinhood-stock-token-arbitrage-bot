import type { AppConfig } from "../config/env.js";
import { createRobinhoodWallet, readWalletPrivateKey, requireRpcForLive, viemSwapBroadcast } from "../chain/wallet.js";
import { ExecutionError } from "../domain/errors.js";
import type { TradeRecord } from "../domain/trade.js";
import type { EligibilityResult } from "../eligibility/check.js";
import { assertCanRunStrategy } from "../eligibility/check.js";
import { log } from "../logging/logger.js";
import type { Opportunity } from "../opportunity/types.js";
import type { BotStore } from "../persistence/db.js";
import { persistRiskSideEffects } from "../risk/side-effects.js";
import { assertRiskAllowed, evaluateRisk } from "../risk/engine.js";
import type { RiskBook, RiskContext } from "../risk/types.js";
import { emptyRiskBook } from "../risk/types.js";
import { executeLiveSwap } from "./live.js";
import { simulateFill } from "./paper.js";
import { processTradeRegistry, TradeRegistry } from "./registry.js";
import type { SwapBroadcast } from "./types.js";

export async function executeTrade(args: {
  config: AppConfig;
  eligibility: EligibilityResult;
  opportunity?: Opportunity;
  book?: RiskBook;
  now?: number;
  currentMultiplier?: bigint;
  currentAssetStatus?: string;
  currentHalt?: boolean;
  proposedNotionalUsd?: number;
  registry?: TradeRegistry;
  store?: BotStore;
  /** Test seam. Production live path builds a viem wallet from env. */
  broadcast?: SwapBroadcast;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}): Promise<TradeRecord> {
  if (args.config.liveTrading) {
    assertCanRunStrategy(args.eligibility);
  }

  const book = args.book ?? emptyRiskBook();
  const context: RiskContext = {
    opportunity: args.opportunity,
    proposedNotionalUsd: args.proposedNotionalUsd,
    currentMultiplier: args.currentMultiplier,
    currentAssetStatus: args.currentAssetStatus,
    currentHalt: args.currentHalt,
    now: args.now,
    book,
  };
  const verdict = evaluateRisk(args.config, context);
  log.info("execution.precheck", {
    liveTrading: args.config.liveTrading,
    paperMode: !args.config.liveTrading,
    riskAllowed: verdict.allowed,
    code: verdict.code,
    reason: verdict.reason,
  });
  await persistRiskSideEffects({
    config: args.config,
    book,
    store: args.store,
    now: args.now ? new Date(args.now) : undefined,
    fetchImpl: args.fetchImpl,
  });
  assertRiskAllowed(verdict);

  const opportunity = args.opportunity;
  if (!opportunity) {
    throw new ExecutionError("Risk allowed without an opportunity; refusing to execute");
  }

  const registry = args.registry ?? (args.store ? new TradeRegistry(args.store) : processTradeRegistry);

  let trade: TradeRecord;
  if (!args.config.liveTrading) {
    trade = simulateFill({
      opportunity,
      verdict,
      book,
      registry,
      now: args.now,
    });
  } else {
    if (args.config.walletKmsRefConfigured && !args.config.walletPrivateKeyConfigured) {
      throw new ExecutionError(
        "WALLET_KMS_REF is set but KMS signing is not implemented in Phase 4. Use WALLET_PRIVATE_KEY locally and never commit it.",
      );
    }

    const broadcast =
      args.broadcast ??
      (() => {
        if (!args.config.walletPrivateKeyConfigured) {
          throw new ExecutionError(
            "LIVE_TRADING=true requires WALLET_PRIVATE_KEY in the environment. Never commit the key.",
          );
        }
        return viemSwapBroadcast(
          createRobinhoodWallet(requireRpcForLive(args.config.rpcUrl), readWalletPrivateKey(args.env ?? process.env)),
        );
      })();

    trade = await executeLiveSwap({
      config: args.config,
      opportunity,
      verdict,
      book,
      registry,
      broadcast,
      now: args.now,
      fetchImpl: args.fetchImpl,
    });
    if (trade.state === "failed") {
      await persistRiskSideEffects({
        config: args.config,
        book,
        store: args.store,
        now: args.now ? new Date(args.now) : undefined,
        fetchImpl: args.fetchImpl,
      });
      throw new ExecutionError(trade.failureReason ?? "Live execution failed after submit");
    }
  }

  await persistRiskSideEffects({
    config: args.config,
    book,
    store: args.store,
    now: args.now ? new Date(args.now) : undefined,
    fetchImpl: args.fetchImpl,
  });
  return trade;
}
