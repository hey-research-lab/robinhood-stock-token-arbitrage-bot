import { PhaseNotImplementedError } from "../../domain/errors.js";
import type { DexAdapter, DexQuote, DexQuoteRequest } from "./types.js";

export const arcusAdapter: DexAdapter = {
  venue: "arcus",
  async quote(_request: DexQuoteRequest): Promise<DexQuote> {
    throw new PhaseNotImplementedError(
      2,
      "Arcus AMM quotes — router address and ABI are not confirmed; will not be invented",
    );
  },
};
