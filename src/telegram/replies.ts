import { formatUsd, sumCosts } from "../lib/money.ts";
import type { OpenRouterCharge } from "../llm/rank.ts";
import type { PipelineResult } from "../pipeline.ts";

export function formatTopicList(topics: readonly string[]): string {
  if (topics.length === 0) return "";
  if (topics.length === 1) return topics[0] ?? "";
  if (topics.length === 2) return `${topics[0]} and ${topics[1]}`;
  const last = topics[topics.length - 1] ?? "";
  return `${topics.slice(0, -1).join(", ")}, and ${last}`;
}

export function formatRankingErrorLine(topics: readonly string[]): string | null {
  if (topics.length === 0) return null;
  return `Error in ${formatTopicList(topics)}.`;
}

export function formatOpenRouterSummary(charges: OpenRouterCharge[]): string {
  return `OpenRouter total: ${formatUsd(sumCosts(charges.map((charge) => charge.cost)))}`;
}

export function formatPipelineReply(result: PipelineResult): string {
  const errorLine = formatRankingErrorLine(result.rankingFailedTopics);
  const summary = formatOpenRouterSummary(result.charges);
  const lines: string[] = [];

  if (!result.ok) {
    lines.push(
      result.rankingFailedTopics.length > 0
        ? "News run failed."
        : `News run failed: ${result.error}`,
    );
  } else if (result.reason === "no_fresh_candidates") {
    lines.push("Done - nothing new to post.");
  } else if (result.reason === "none_passed_threshold") {
    lines.push("Done - no items passed the relevance threshold.");
  } else {
    lines.push(
      `Done - sent newsletter with ${result.posted} stor${result.posted === 1 ? "y" : "ies"}.`,
    );
  }

  if (errorLine) lines.push(errorLine);
  lines.push(summary);
  return lines.join("\n\n");
}
