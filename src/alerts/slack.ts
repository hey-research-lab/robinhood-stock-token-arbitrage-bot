import { log } from "../logging/logger.js";
import type { RiskBook } from "../risk/types.js";

export async function sendKillSwitchAlert(args: {
  webhookUrl: string | undefined;
  reason: string;
  dailyPnlUsd: number;
  fetchImpl?: typeof fetch;
}): Promise<{ sent: boolean; skipped?: string }> {
  const url = args.webhookUrl?.trim();
  if (!url) {
    return { sent: false, skipped: "SLACK_WEBHOOK_URL is empty" };
  }
  const fetchImpl = args.fetchImpl ?? fetch;
  const body = {
    text: `Stock Token bot kill switch tripped. Reason: ${args.reason}. Daily PnL: ${args.dailyPnlUsd} USD. No further trades until resetKillSwitch.`,
  };
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      log.error("alert.slack_failed", { status: res.status });
      return { sent: false, skipped: `Slack HTTP ${res.status}` };
    }
    log.info("alert.slack_sent", { dailyPnlUsd: args.dailyPnlUsd });
    return { sent: true };
  } catch (err) {
    log.error("alert.slack_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return { sent: false, skipped: err instanceof Error ? err.message : String(err) };
  }
}

export async function flushKillSwitchAlert(args: {
  book: RiskBook;
  webhookUrl: string | undefined;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  if (!args.book.killSwitchNeedsAlert || args.book.killSwitchAlerted) {
    return;
  }
  const result = await sendKillSwitchAlert({
    webhookUrl: args.webhookUrl,
    reason: args.book.killSwitchReason ?? "Kill switch tripped",
    dailyPnlUsd: args.book.dailyPnlUsd,
    fetchImpl: args.fetchImpl,
  });
  args.book.killSwitchNeedsAlert = false;
  if (result.sent) {
    args.book.killSwitchAlerted = true;
  } else {
    log.warn("alert.slack_skipped", { reason: result.skipped ?? "unknown" });
    args.book.killSwitchAlerted = Boolean(args.webhookUrl?.trim());
  }
}
