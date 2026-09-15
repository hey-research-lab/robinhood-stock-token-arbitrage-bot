import type { AppConfig } from "../config/env.js";
import type { EligibilityResult } from "../eligibility/check.js";
import { assertCanRunStrategy } from "../eligibility/check.js";
import type { SymbolSnapshot } from "../marketdata/collect.js";
import { findOpportunities } from "../opportunity/engine.js";
import type { OpportunityScan } from "../opportunity/types.js";

/**
 * Strategy loop is gated on eligibility. Market-data collection and paper
 * opportunity scanning may run without this.
 */
export async function runStrategyLoop(
  eligibility: EligibilityResult,
  args: { snapshots: SymbolSnapshot[]; config: AppConfig; now?: number },
): Promise<OpportunityScan> {
  assertCanRunStrategy(eligibility);
  return findOpportunities(args);
}
