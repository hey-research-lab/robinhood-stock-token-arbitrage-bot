import { PhaseNotImplementedError } from "../../domain/errors.js";
import type { DexAdapter, DexQuote, DexQuoteRequest } from "./types.js";

export const pleiadesAdapter: DexAdapter = {
  venue: "pleiades",
  async quote(_request: DexQuoteRequest): Promise<DexQuote> {
    throw new PhaseNotImplementedError(
      2,
      "Pleiades AMM quotes — router address and ABI are not confirmed; will not be invented",
    );
  },
};
