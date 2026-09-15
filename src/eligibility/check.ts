import { BLOCKED_JURISDICTIONS } from "../config/constants.js";
import type { AppConfig } from "../config/env.js";
import { EligibilityError } from "../domain/errors.js";

export interface EligibilityResult {
  allowedForExecution: boolean;
  blocked: boolean;
  reason: string;
  jurisdiction?: string;
  eligiblePerson: boolean;
}

function normalizeJurisdiction(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const upper = code.toUpperCase();
  if (upper === "UK") return "GB";
  return upper;
}

export function evaluateEligibility(config: Pick<AppConfig, "eligiblePerson" | "jurisdiction">): EligibilityResult {
  const jurisdiction = normalizeJurisdiction(config.jurisdiction);

  if (!config.eligiblePerson) {
    return {
      allowedForExecution: false,
      blocked: true,
      reason:
        "ELIGIBLE_PERSON is false (default). Market-data and paper simulation may still run; strategy and live execution will not.",
      jurisdiction,
      eligiblePerson: false,
    };
  }

  if (!jurisdiction) {
    return {
      allowedForExecution: false,
      blocked: true,
      reason: "JURISDICTION is required when ELIGIBLE_PERSON=true.",
      eligiblePerson: true,
    };
  }

  if ((BLOCKED_JURISDICTIONS as readonly string[]).includes(jurisdiction) || jurisdiction === "UK") {
    return {
      allowedForExecution: false,
      blocked: true,
      reason: `Stock Tokens are restricted for US, UK, Canadian, and Swiss persons (blocked: ${jurisdiction}).`,
      jurisdiction,
      eligiblePerson: true,
    };
  }

  return {
    allowedForExecution: true,
    blocked: false,
    reason: "Eligibility flag set and jurisdiction is not on the US/GB/CA/CH blocklist.",
    jurisdiction,
    eligiblePerson: true,
  };
}

export function assertCanRunStrategy(result: EligibilityResult): void {
  if (!result.allowedForExecution) {
    throw new EligibilityError(result.reason);
  }
}
