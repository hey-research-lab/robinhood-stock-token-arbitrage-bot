import { describe, expect, it } from "vitest";
import { EligibilityError } from "../src/domain/errors.js";
import { assertCanRunStrategy, evaluateEligibility } from "../src/eligibility/check.js";

describe("eligibility", () => {
  it("defaults to blocked when ELIGIBLE_PERSON is false", () => {
    const result = evaluateEligibility({ eligiblePerson: false, jurisdiction: "DE" });
    expect(result.allowedForExecution).toBe(false);
    expect(result.blocked).toBe(true);
  });

  it("blocks US, GB/UK, CA, and CH even if the flag is true", () => {
    for (const jurisdiction of ["US", "GB", "UK", "CA", "CH"]) {
      const result = evaluateEligibility({ eligiblePerson: true, jurisdiction });
      expect(result.allowedForExecution, jurisdiction).toBe(false);
    }
  });

  it("allows a non-blocked jurisdiction when the flag is explicit", () => {
    const result = evaluateEligibility({ eligiblePerson: true, jurisdiction: "DE" });
    expect(result.allowedForExecution).toBe(true);
  });

  it("gates the strategy loop helper", () => {
    expect(() =>
      assertCanRunStrategy(evaluateEligibility({ eligiblePerson: false, jurisdiction: undefined })),
    ).toThrow(EligibilityError);
  });
});
