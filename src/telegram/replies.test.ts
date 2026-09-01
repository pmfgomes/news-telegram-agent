import { describe, expect, test } from "bun:test";
import type { OpenRouterCharge } from "../llm/rank.ts";
import {
  formatOpenRouterSummary,
  formatPipelineReply,
  formatRankingErrorLine,
  formatTopicList,
} from "./replies.ts";

function charge(
  overrides: Partial<OpenRouterCharge> & Pick<OpenRouterCharge, "topic" | "cost">,
): OpenRouterCharge {
  return {
    model: "google/gemini-2.5-flash-lite",
    runId: "run-1",
    promptTokens: 100,
    completionTokens: 50,
    ...overrides,
  };
}

describe("formatTopicList", () => {
  test("joins one, two, and many names", () => {
    expect(formatTopicList(["AI"])).toBe("AI");
    expect(formatTopicList(["AI", "Gaming"])).toBe("AI and Gaming");
    expect(formatTopicList(["AI", "Gaming", "World news"])).toBe("AI, Gaming, and World news");
  });
});

describe("formatRankingErrorLine", () => {
  test("names the failed sections", () => {
    expect(formatRankingErrorLine([])).toBeNull();
    expect(formatRankingErrorLine(["AI", "Gaming"])).toBe("Error in AI and Gaming.");
  });
});

describe("formatOpenRouterSummary", () => {
  test("reports only the billed total", () => {
    expect(
      formatOpenRouterSummary([
        charge({ topic: "Technology", cost: 0.001 }),
        charge({ topic: "Algarve", cost: 0.0004 }),
      ]),
    ).toBe("OpenRouter total: $0.0014");
  });

  test("still shows a zero total when nothing was billed", () => {
    expect(formatOpenRouterSummary([])).toBe("OpenRouter total: $0.00");
  });
});

describe("formatPipelineReply", () => {
  const charges = [charge({ topic: "Technology", cost: 0.002 })];

  test("appends the OpenRouter total to a successful send", () => {
    expect(
      formatPipelineReply({
        ok: true,
        posted: 12,
        rankingFailedTopics: [],
        charges,
      }),
    ).toBe("Done - sent newsletter with 12 stories.\n\nOpenRouter total: $0.002");
  });

  test("lists failed sections without dumping parse errors", () => {
    expect(
      formatPipelineReply({
        ok: true,
        posted: 32,
        rankingFailedTopics: ["AI", "Gaming", "World news"],
        charges,
      }),
    ).toBe(
      "Done - sent newsletter with 32 stories.\n\nError in AI, Gaming, and World news.\n\nOpenRouter total: $0.002",
    );
  });

  test("keeps a non-ranking failure message and the total", () => {
    expect(
      formatPipelineReply({
        ok: false,
        error: "Topic is missing: Algarve",
        rankingFailedTopics: [],
        charges,
      }),
    ).toBe("News run failed: Topic is missing: Algarve\n\nOpenRouter total: $0.002");
  });

  test("uses Error in … when every topic failed ranking", () => {
    expect(
      formatPipelineReply({
        ok: false,
        error: "AI: Failed to parse LLM JSON",
        rankingFailedTopics: ["AI", "Gaming"],
        charges,
      }),
    ).toBe("News run failed.\n\nError in AI and Gaming.\n\nOpenRouter total: $0.002");
  });
});
