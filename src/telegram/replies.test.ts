import { describe, expect, test } from "bun:test";
import type { OpenRouterCharge } from "../llm/rank.ts";
import {
  formatOpenRouterChargeLine,
  formatOpenRouterSummary,
  formatPipelineReply,
} from "./replies.ts";

function charge(
  overrides: Partial<OpenRouterCharge> & Pick<OpenRouterCharge, "topic" | "cost">,
): OpenRouterCharge {
  return {
    model: "google/gemini-2.5-flash-lite",
    generationId: "gen-1",
    promptTokens: 100,
    completionTokens: 50,
    ...overrides,
  };
}

describe("formatOpenRouterChargeLine", () => {
  test("reports topic and billed USD", () => {
    expect(
      formatOpenRouterChargeLine(charge({ topic: "Technology", cost: 0.001234 })),
    ).toBe("OpenRouter · Technology · $0.001234");
  });
});

describe("formatOpenRouterSummary", () => {
  test("lists every charge and the total", () => {
    expect(
      formatOpenRouterSummary([
        charge({ topic: "Technology", cost: 0.001 }),
        charge({ topic: "Algarve", cost: 0.0004 }),
      ]),
    ).toBe("OpenRouter\nTechnology: $0.001\nAlgarve: $0.0004\nTotal: $0.0014");
  });

  test("still shows a zero total when nothing was billed", () => {
    expect(formatOpenRouterSummary([])).toBe("OpenRouter\nTotal: $0.00");
  });
});

describe("formatPipelineReply", () => {
  const charges = [charge({ topic: "Technology", cost: 0.002 })];

  test("appends itemized OpenRouter costs to a successful send", () => {
    expect(
      formatPipelineReply({
        ok: true,
        posted: 12,
        rankingFailedTopics: [],
        charges,
      }),
    ).toBe(
      "Done - sent newsletter with 12 stories.\n\nOpenRouter\nTechnology: $0.002\nTotal: $0.002",
    );
  });

  test("includes charges when the run failed after ranking", () => {
    expect(
      formatPipelineReply({
        ok: false,
        error: "Topic is missing: Algarve",
        charges,
      }),
    ).toBe(
      "News run failed: Topic is missing: Algarve\n\nOpenRouter\nTechnology: $0.002\nTotal: $0.002",
    );
  });
});
