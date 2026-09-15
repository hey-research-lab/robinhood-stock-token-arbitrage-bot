import { applyBps, edgeBps, formatScaled, parseDecimalToScaled } from "../normalize/units.js";
import type { CostBreakdown, CostInputs } from "./types.js";

export function computeCosts(input: CostInputs): CostBreakdown {
  const extraFeeUsdScaled = applyBps(input.notionalUsdScaled, input.extraFeeBps);
  const slippageUsdScaled = applyBps(input.notionalUsdScaled, input.slippageBps);
  const riskBufferUsdScaled = applyBps(input.notionalUsdScaled, input.riskBufferBps);
  const netEdgeUsdScaled =
    input.grossEdgeUsdScaled -
    extraFeeUsdScaled -
    slippageUsdScaled -
    input.gasUsdScaled -
    riskBufferUsdScaled;

  return {
    notionalUsd: formatScaled(input.notionalUsdScaled),
    notionalUsdScaled: input.notionalUsdScaled,
    grossEdgeUsd: formatScaled(input.grossEdgeUsdScaled),
    grossEdgeUsdScaled: input.grossEdgeUsdScaled,
    grossEdgeBps: edgeBps(input.grossEdgeUsdScaled, input.notionalUsdScaled),
    extraFeeUsd: formatScaled(extraFeeUsdScaled),
    extraFeeUsdScaled,
    extraFeeBps: input.extraFeeBps,
    slippageUsd: formatScaled(slippageUsdScaled),
    slippageUsdScaled,
    slippageBps: input.slippageBps,
    gasUsd: formatScaled(input.gasUsdScaled),
    gasUsdScaled: input.gasUsdScaled,
    gasSource: input.gasSource,
    riskBufferUsd: formatScaled(riskBufferUsdScaled),
    riskBufferUsdScaled,
    riskBufferBps: input.riskBufferBps,
    netEdgeUsd: formatScaled(netEdgeUsdScaled),
    netEdgeUsdScaled,
    netEdgeBps: edgeBps(netEdgeUsdScaled, input.notionalUsdScaled),
  };
}

export function parseGasUsd(raw: string | undefined, fallbackUsd: number): { scaled: bigint; usedFallback: boolean } {
  if (raw === undefined || raw.trim() === "") {
    return { scaled: parseDecimalToScaled(fallbackUsd.toFixed(8), 18), usedFallback: true };
  }
  return { scaled: parseDecimalToScaled(raw, 18), usedFallback: false };
}
