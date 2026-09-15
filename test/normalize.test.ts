import { describe, expect, it } from "vitest";
import { MULTIPLIER_SCALE } from "../src/config/constants.js";
import {
  chainlinkAnswerToTokenUsd,
  formatScaled,
  parseDecimalToScaled,
  restShareToTokenUsd,
} from "../src/normalize/units.js";

describe("price normalization", () => {
  it("multiplies REST share prices by uiMultiplier to get USD per raw token", () => {
    const multiplier = parseDecimalToScaled("1.05");
    const tokenUsd = restShareToTokenUsd("100", multiplier);
    expect(formatScaled(tokenUsd)).toBe("105");
  });

  it("does not multiply Chainlink answers by uiMultiplier (feed is already token-priced)", () => {
    const answer = 105n * 10n ** 8n;
    const tokenUsd = chainlinkAnswerToTokenUsd(answer, 8);
    expect(formatScaled(tokenUsd)).toBe("105");
    const wronglyMultiplied = (tokenUsd * parseDecimalToScaled("1.05")) / MULTIPLIER_SCALE;
    expect(formatScaled(wronglyMultiplied)).toBe("110.25");
    expect(tokenUsd).not.toBe(wronglyMultiplied);
  });

  it("keeps a 1.0 multiplier as identity on REST", () => {
    expect(formatScaled(restShareToTokenUsd("213.45", MULTIPLIER_SCALE))).toBe("213.45");
  });
});
