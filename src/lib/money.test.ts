import { describe, expect, test } from "bun:test";
import { formatUsd, sumCosts } from "./money.ts";

describe("formatUsd", () => {
  test("formats zero and non-finite as $0.00", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(Number.NaN)).toBe("$0.00");
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe("$0.00");
  });

  test("keeps two decimals for dollar amounts", () => {
    expect(formatUsd(1)).toBe("$1.00");
    expect(formatUsd(1.2)).toBe("$1.20");
    expect(formatUsd(12.345)).toBe("$12.35");
  });

  test("keeps extra decimals for sub-dollar OpenRouter charges", () => {
    expect(formatUsd(0.01)).toBe("$0.01");
    expect(formatUsd(0.0123)).toBe("$0.0123");
    expect(formatUsd(0.000123)).toBe("$0.000123");
  });

  test("preserves a minus sign", () => {
    expect(formatUsd(-0.0004)).toBe("-$0.0004");
  });
});

describe("sumCosts", () => {
  test("sums finite amounts and skips junk", () => {
    expect(sumCosts([0.1, 0.2, Number.NaN])).toBeCloseTo(0.3);
  });
});
