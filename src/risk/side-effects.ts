import { flushKillSwitchAlert } from "../alerts/slack.js";
import type { AppConfig } from "../config/env.js";
import type { BotStore } from "../persistence/db.js";
import type { RiskBook } from "./types.js";

export async function persistRiskSideEffects(args: {
  config: AppConfig;
  book: RiskBook;
  store?: BotStore;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  await flushKillSwitchAlert({
    book: args.book,
    webhookUrl: args.config.slackWebhookUrl,
    fetchImpl: args.fetchImpl,
  });
  args.store?.saveRiskBook(args.book, args.now ?? new Date());
}
