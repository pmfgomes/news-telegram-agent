import { formatUsd, sumCosts } from "../lib/money.ts";
import type { OpenRouterCharge } from "../llm/rank.ts";
import type { PipelineResult } from "../pipeline.ts";

export function formatOpenRouterChargeLine(charge: OpenRouterCharge): string {
  return `OpenRouter · ${charge.topic} · ${formatUsd(charge.cost)}`;
}

export function formatOpenRouterSummary(charges: OpenRouterCharge[]): string {
  const lines = ["OpenRouter"];
  for (const charge of charges) {
    lines.push(`${charge.topic}: ${formatUsd(charge.cost)}`);
  }
  lines.push(`Total: ${formatUsd(sumCosts(charges.map((charge) => charge.cost)))}`);
  return lines.join("\n");
}

export function formatPipelineReply(result: PipelineResult): string {
  const summary = formatOpenRouterSummary(result.charges);
  if (!result.ok) {
    return `News run failed: ${result.error}\n\n${summary}`;
  }
  const failed =
    result.rankingFailedTopics.length > 0
      ? ` Ranking failed for ${result.rankingFailedTopics.join(", ")}.`
      : "";
  if (result.reason === "no_fresh_candidates") {
    return `Done - nothing new to post.${failed}\n\n${summary}`;
  }
  if (result.reason === "none_passed_threshold") {
    return `Done - no items passed the relevance threshold.${failed}\n\n${summary}`;
  }
  return `Done - sent newsletter with ${result.posted} stor${result.posted === 1 ? "y" : "ies"}.${failed}\n\n${summary}`;
}
