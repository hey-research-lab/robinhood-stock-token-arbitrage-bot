export class StalePriceError extends Error {
  readonly code = "STALE_PRICE" as const;
  constructor(
    readonly source: string,
    readonly ageMs: number,
    readonly maxAgeMs: number,
  ) {
    super(`Stale ${source} price: age ${ageMs}ms exceeds max ${maxAgeMs}ms`);
    this.name = "StalePriceError";
  }
}

export class EligibilityError extends Error {
  readonly code = "ELIGIBILITY_BLOCKED" as const;
  constructor(message: string) {
    super(message);
    this.name = "EligibilityError";
  }
}

export class PhaseNotImplementedError extends Error {
  readonly code = "PHASE_NOT_IMPLEMENTED" as const;
  constructor(readonly phase: number, feature: string) {
    super(`${feature} is not implemented until Phase ${phase}`);
    this.name = "PhaseNotImplementedError";
  }
}

export class ExecutionError extends Error {
  readonly code = "EXECUTION" as const;
  constructor(message: string) {
    super(message);
    this.name = "ExecutionError";
  }
}
