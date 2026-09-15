import { describe, expect, it } from "vitest";
import { parseDecimalToScaled } from "../src/normalize/units.js";
import { computeCosts } from "../src/opportunity/cost-model.js";

describe("cost model", () => {
  it("subtracts extra fee, slippage, gas, and risk buffer from gross edge", () => {
    const costs = computeCosts({
      grossEdgeUsdScaled: parseDecimalToScaled("2"),
      notionalUsdScaled: parseDecimalToScaled("200"),
      extraFeeBps: 0,
      slippageBps: 30,
      gasUsdScaled: parseDecimalToScaled("0.05"),
      gasSource: "config_fallback",
      riskBufferBps: 10,
    });
    expect(costs.slippageUsd).toBe("0.6");
    expect(costs.riskBufferUsd).toBe("0.2");
    expect(costs.gasUsd).toBe("0.05");
    expect(costs.netEdgeUsd).toBe("1.15");
    expect(costs.netEdgeBps).toBe(57);
  });
});
