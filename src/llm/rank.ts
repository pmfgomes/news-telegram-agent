import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import OpenAI from "openai";
import { ZodError } from "zod";
import { dataDir } from "../config/index.ts";
import { logger } from "../lib/logger.ts";
import {
  formatZodError,
  llmRankResponseSchema,
  openRouterUsageSchema,
  type LlmRankRow,
} from "../lib/schemas.ts";
import type { AppConfig, NewsItem, RankedItem, TopicConfig } from "../lib/types.ts";

export type RankTopicError = {
  topic: string;
  error: string;
};

export type OpenRouterCharge = {
  topic: string;
  model: string;
  generationId: string;
  cost: number;
  promptTokens: number;
  completionTokens: number;
};

export type RankResult = {
  items: RankedItem[];
  /** Exact cost from OpenRouter usage.cost (credits charged). */
  cost: number;
  charges: OpenRouterCharge[];
  errors: RankTopicError[];
};

/** Shared OpenRouter completion budget for ranking JSON (fits ~50 clusters). */
export const RANK_MAX_TOKENS = 16384;
/**
 * Cap for reasoning/thinking tokens. Must stay strictly below RANK_MAX_TOKENS
 * so the model still has room for the JSON answer.
 */
export const RANK_REASONING_MAX_TOKENS = 2048;
const CONTENT_PREVIEW_LIMIT = 400;

export type RankParseStage =
  | "empty_content"
  | "no_json_object"
  | "invalid_json"
  | "schema_mismatch";

/** Ranking parse failure that records which stage rejected the response. */
export class RankParseError extends Error {
  readonly stage: RankParseStage;
  /** Exact string handed to JSON.parse, when extraction got that far. */
  readonly payload: string | null;

  constructor(
    message: string,
    stage: RankParseStage,
    payload: string | null = null,
  ) {
    super(message);
    this.name = "RankParseError";
    this.stage = stage;
    this.payload = payload;
  }
}

export type TopicCandidatesProvider = (
  topic: TopicConfig,
) => Promise<NewsItem[]>;

/** OpenRouter ranking request fields the OpenAI SDK types do not cover. */
export type OpenRouterRankCompletionParams = {
  model: string;
  temperature: number;
  max_tokens: number;
  response_format: { type: "json_object" };
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  usage: { include: true };
  plugins: [{ id: "response-healing" }];
  reasoning: { max_tokens: number; exclude: true };
};

export function buildRankCompletionParams(opts: {
  model: string;
  prompt: string;
}): OpenRouterRankCompletionParams {
  return {
    model: opts.model,
    temperature: 0.2,
    max_tokens: RANK_MAX_TOKENS,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are a precise news clustering and ranking assistant. Reply with JSON only.",
      },
      { role: "user", content: opts.prompt },
    ],
    usage: { include: true },
    plugins: [{ id: "response-healing" }],
    reasoning: {
      max_tokens: RANK_REASONING_MAX_TOKENS,
      exclude: true,
    },
  };
}

function emptyRankResult(): RankResult {
  return { items: [], cost: 0, charges: [], errors: [] };
}

export async function mapTopicsAsCandidatesReady<T>(
  topics: TopicConfig[],
  getCandidates: TopicCandidatesProvider,
  processTopic: (
    topic: TopicConfig,
    candidates: NewsItem[],
  ) => Promise<T>,
): Promise<T[]> {
  return Promise.all(
    topics.map(async (topic) =>
      processTopic(topic, await getCandidates(topic)),
    ),
  );
}

function topicLabel(topic: TopicConfig): string {
  return `${topic.name}: ${topic.interest}`;
}

function formatCandidates(candidates: NewsItem[]): string {
  return candidates
    .map((c, i) => {
      const summary = c.summary ? ` | summary: ${c.summary.slice(0, 180)}` : "";
      const published = c.publishedAt
        ? ` | published=${c.publishedAt.toISOString()}`
        : "";
      return `${i + 1}. id=${JSON.stringify(c.id)} | source=${c.source} | title=${JSON.stringify(c.title)}${summary}${published} | link=${c.link}`;
    })
    .join("\n");
}

function buildFilterPrompt(
  topic: TopicConfig,
  candidates: NewsItem[],
  topN: number,
): string {
  return `You organize and rank news into Google News-style story clusters for one Telegram topic.

Topic:
- name=${JSON.stringify(topic.name)} | ${topic.interest}

Group candidates that report the SAME concrete event or development. Choose the best article as the primary id and place other coverage in related_ids.
Score each cluster from 0.0 to 1.0 for relevance to this topic.
Return ONLY valid JSON with this shape:
{"rankings":[{"id":"primary-id","related_ids":["related-id"],"topic":${JSON.stringify(topic.name)},"score":0.0,"summary":"one or two short factual sentences"}]}

Rules:
- topic must be exactly ${JSON.stringify(topic.name)}.
- Follow every inclusion and exclusion in the topic description strictly.
- Cluster only articles about the same event, announcement, release, incident, or development—not merely the same broad subject.
- Choose the clearest, most informative article as id.
- related_ids may contain at most 4 other candidate ids.
- An id must appear in only one cluster.
- Prefer concrete, timely, high-signal stories over vague fluff.
- summary must be one or two short factual sentences about what happened; do not explain relevance.
- ids must match the provided ids exactly.
- Sort clusters by score descending.
- Skip items that do not fit this topic well (omit them or give a low score).
- Return at most ${topN} clusters (the best stories only).

Candidates:
${formatCandidates(candidates)}`;
}

function buildLatestPrompt(
  topic: TopicConfig,
  candidates: NewsItem[],
  topN: number,
): string {
  return `You cluster news for one Telegram topic. Sources are already on-topic — do NOT filter by relevance or place name.

Topic:
- name=${JSON.stringify(topic.name)} | ${topic.interest}

Your only job is to deduplicate: group candidates that report the SAME concrete event, and pick the newest distinct stories.
Return ONLY valid JSON with this shape:
{"rankings":[{"id":"primary-id","related_ids":["related-id"],"topic":${JSON.stringify(topic.name)},"score":1.0,"summary":"one or two short factual sentences"}]}

Rules:
- topic must be exactly ${JSON.stringify(topic.name)}.
- Treat every candidate as valid for this topic. Do not omit stories for being "not Algarve enough" or similar.
- Cluster only articles about the same event, announcement, release, incident, or development—not merely the same broad subject.
- Choose the clearest, most informative article as id; put other coverage in related_ids (at most 4).
- An id must appear in only one cluster.
- Score every returned cluster 1.0.
- summary must be one or two short factual sentences about what happened; do not explain relevance.
- ids must match the provided ids exactly.
- Sort clusters by recency (newest primary article first), using published timestamps when available.
- Return at most ${topN} clusters — the newest distinct stories after deduplication.
- Prefer covering as many distinct recent stories as possible up to ${topN}.

Candidates:
${formatCandidates(candidates)}`;
}

function buildPrompt(
  topic: TopicConfig,
  candidates: NewsItem[],
  topN: number,
): string {
  return topic.ranking_mode === "latest"
    ? buildLatestPrompt(topic, candidates, topN)
    : buildFilterPrompt(topic, candidates, topN);
}

function previewContent(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= CONTENT_PREVIEW_LIMIT) return trimmed;
  return `${trimmed.slice(0, CONTENT_PREVIEW_LIMIT)}…`;
}

/** Tail preview: truncation and unbalanced-brace failures show up at the end. */
function previewTail(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length <= CONTENT_PREVIEW_LIMIT) return undefined;
  return `…${trimmed.slice(-CONTENT_PREVIEW_LIMIT)}`;
}

/**
 * Persist the complete failing completion (all choices, usage, provider
 * metadata) so a parse failure can be diagnosed from the exact payload
 * instead of a log preview. Returns the file path, or null if the dump
 * itself failed (never breaks the run).
 */
function dumpFailedCompletion(opts: {
  topic: string;
  model: string;
  stage: RankParseStage | null;
  error: string;
  content: string;
  completion: OpenAI.Chat.ChatCompletion;
}): string | null {
  const dir = join(dataDir(), "logs", "llm-failures");
  const slug =
    opts.topic
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "topic";
  const path = join(
    dir,
    `${new Date().toISOString().replace(/[:.]/g, "-")}-${slug}.json`,
  );
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          at: new Date().toISOString(),
          topic: opts.topic,
          requested_model: opts.model,
          stage: opts.stage,
          error: opts.error,
          content: opts.content,
          completion: opts.completion,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return path;
  } catch (err) {
    logger.warn(
      {
        event: "llm_failure_dump_failed",
        topic: opts.topic,
        path,
        error: String(err),
      },
      "Could not write LLM failure dump",
    );
    return null;
  }
}

/** Join OpenAI/OpenRouter message content, including array-of-parts payloads. */
export function completionText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (
          part !== null &&
          typeof part === "object" &&
          "text" in part &&
          typeof part.text === "string"
        ) {
          return part.text;
        }
        return "";
      })
      .join("");
  }
  return "";
}

/** Pull the outermost JSON object out of fences, prose, or a BOM. */
export function extractJsonObject(content: string): string {
  let text = content.replace(/^\uFEFF/, "").trim();
  if (!text) {
    throw new RankParseError(
      "Failed to parse LLM JSON: empty response",
      "empty_content",
    );
  }

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    text = fence[1].trim();
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new RankParseError(
      "Failed to parse LLM JSON: no JSON object found",
      "no_json_object",
    );
  }
  return text.slice(start, end + 1);
}

export function parseRankings(content: unknown): LlmRankRow[] {
  const text = completionText(content);
  const payload = extractJsonObject(text);
  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch (err) {
    throw new RankParseError(
      `Failed to parse LLM JSON: ${String(err)}`,
      "invalid_json",
      payload,
    );
  }

  try {
    return llmRankResponseSchema.parse(json).rankings;
  } catch (err) {
    if (err instanceof ZodError) {
      throw new RankParseError(
        `Invalid LLM ranking JSON:\n${formatZodError(err)}`,
        "schema_mismatch",
        payload,
      );
    }
    throw err;
  }
}

function candidatesForTopic(
  topic: TopicConfig,
  candidates: NewsItem[],
  sourceTopics: Map<string, string[]>,
  maxCandidates: number,
): NewsItem[] {
  return candidates
    .filter((candidate) =>
      sourceTopics
        .get(candidate.source)
        ?.some((name) => name.toLowerCase() === topic.name.toLowerCase()),
    )
    .sort(
      (a, b) =>
        (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0),
    )
    .slice(0, maxCandidates);
}

async function rankForTopic(
  client: OpenAI,
  topic: TopicConfig,
  candidates: NewsItem[],
  opts: {
    model: string;
    threshold: number;
    topN: number;
    threadId: number;
    onCharge?: (charge: OpenRouterCharge) => void | Promise<void>;
  },
): Promise<RankResult> {
  const started = Date.now();
  const threshold =
    topic.ranking_mode === "latest" ? 0 : opts.threshold;
  logger.info(
    {
      event: "llm_request",
      model: opts.model,
      topic: topic.name,
      ranking_mode: topic.ranking_mode,
      candidateCount: candidates.length,
      candidateSources: Object.fromEntries(
        [...new Set(candidates.map((candidate) => candidate.source))].map(
          (source) => [
            source,
            candidates.filter((candidate) => candidate.source === source).length,
          ],
        ),
      ),
      interest: topic.interest,
    },
    "Requesting LLM ranking for topic",
  );

  const completion = await client.chat.completions.create(
    buildRankCompletionParams({
      model: opts.model,
      prompt: buildPrompt(topic, candidates, opts.topN),
    }) as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
  );

  const latencyMs = Date.now() - started;
  const choice = completion.choices[0];
  const content = completionText(choice?.message?.content);
  const finishReason = choice?.finish_reason ?? null;
  // OpenRouter extensions that the OpenAI SDK does not type.
  const provider =
    "provider" in completion && typeof completion.provider === "string"
      ? completion.provider
      : null;
  const nativeFinishReason =
    choice !== undefined &&
    "native_finish_reason" in choice &&
    typeof choice.native_finish_reason === "string"
      ? choice.native_finish_reason
      : null;
  const usage = openRouterUsageSchema.catch({}).parse(completion.usage ?? {});
  const promptTokens = usage.prompt_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? promptTokens + completionTokens;
  const cost = usage.cost ?? 0;
  const upstreamCost = usage.cost_details?.upstream_inference_cost;

  logger.info(
    {
      event: "llm_response",
      model: opts.model,
      served_model: completion.model,
      provider,
      topic: topic.name,
      generation_id: completion.id,
      finish_reason: finishReason,
      content_length: content.length,
      latency_ms: latencyMs,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
    },
    "LLM ranking response",
  );

  logger.info(
    {
      event: "llm_cost",
      model: opts.model,
      topic: topic.name,
      generation_id: completion.id,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: totalTokens,
      cost,
      upstream_inference_cost: upstreamCost,
    },
    "OpenRouter billed cost",
  );

  const charge: OpenRouterCharge = {
    topic: topic.name,
    model: opts.model,
    generationId: completion.id ?? "",
    cost,
    promptTokens,
    completionTokens,
  };
  try {
    await opts.onCharge?.(charge);
  } catch (err) {
    logger.warn(
      {
        event: "llm_charge_notify_failed",
        topic: topic.name,
        error: String(err),
      },
      "Failed to notify OpenRouter charge",
    );
  }

  let parsed: LlmRankRow[];
  try {
    parsed = parseRankings(content);
  } catch (err) {
    const truncated = finishReason === "length" ? " (response truncated)" : "";
    const message = err instanceof Error ? err.message : String(err);
    const error = `${message}${truncated}`;
    const stage = err instanceof RankParseError ? err.stage : null;
    const payload = err instanceof RankParseError ? err.payload : null;
    const dumpPath = dumpFailedCompletion({
      topic: topic.name,
      model: opts.model,
      stage,
      error,
      content,
      completion,
    });
    logger.error(
      {
        event: "llm_json_parse_failed",
        model: opts.model,
        served_model: completion.model,
        provider,
        topic: topic.name,
        generation_id: completion.id,
        stage,
        finish_reason: finishReason,
        native_finish_reason: nativeFinishReason,
        refusal: choice?.message?.refusal ?? null,
        choice_count: completion.choices.length,
        completion_tokens: completionTokens,
        max_tokens: RANK_MAX_TOKENS,
        content_length: content.length,
        content_preview: previewContent(content),
        content_tail: previewTail(content),
        payload_length: payload?.length,
        payload_tail: payload === null ? undefined : previewTail(payload),
        dump_path: dumpPath,
        error,
      },
      "Failed to parse LLM ranking JSON",
    );
    return {
      items: [],
      cost,
      charges: [charge],
      errors: [{ topic: topic.name, error }],
    };
  }

  const rankings = parsed
    .filter((row) => Number.isFinite(row.score) && row.score >= threshold)
    .sort((a, b) => {
      if (topic.ranking_mode === "latest") {
        const aItem = candidates.find((c) => c.id === a.id);
        const bItem = candidates.find((c) => c.id === b.id);
        return (
          (bItem?.publishedAt?.getTime() ?? 0) -
          (aItem?.publishedAt?.getTime() ?? 0)
        );
      }
      return b.score - a.score;
    });
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const selected: RankedItem[] = [];
  const seen = new Set<string>();

  for (const row of rankings) {
    if (selected.length >= opts.topN) break;
    if (seen.has(row.id)) continue;
    const item = byId.get(row.id);
    if (!item) continue;

    const relatedItems = [...new Set(row.related_ids)]
      .filter((id) => id !== row.id && !seen.has(id))
      .map((id) => byId.get(id))
      .filter((related): related is NewsItem => related !== undefined)
      .slice(0, 4);

    seen.add(item.id);
    for (const related of relatedItems) {
      seen.add(related.id);
    }
    const llmSummary = row.summary.trim();
    const rssSummary = item.summary?.trim() ?? "";
    selected.push({
      ...item,
      topic: topic.name,
      score: topic.ranking_mode === "latest" ? 1 : row.score,
      summary: llmSummary || rssSummary || item.title,
      threadId: opts.threadId,
      relatedItems,
    });
  }

  logger.info(
    {
      event: "llm_rank_topic_done",
      topic: topic.name,
      ranking_mode: topic.ranking_mode,
      selectedCount: selected.length,
      relatedCount: selected.reduce(
        (sum, item) => sum + item.relatedItems.length,
        0,
      ),
      threshold,
    },
    "Selected top story clusters for topic",
  );

  return { items: selected, cost, charges: [charge], errors: [] };
}

export async function rankTopics(
  config: AppConfig,
  getCandidates: TopicCandidatesProvider,
  opts: {
    apiKey: string;
    model: string;
    threadIds: Map<string, number>;
    onCharge?: (charge: OpenRouterCharge) => void | Promise<void>;
  },
): Promise<RankResult> {
  const client = new OpenAI({
    apiKey: opts.apiKey,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": "https://github.com/pmfgomes/news-telegram-agent",
      "X-Title": "news-telegram-agent",
    },
  });

  logger.info(
    {
      event: "llm_rank_parallel_start",
      model: opts.model,
      topics: config.topics.map(topicLabel),
    },
    "Ranking topics as their source fetches complete",
  );

  const sourceTopics = new Map(
    config.sources.map((source) => [source.name, source.topics]),
  );
  const results = await mapTopicsAsCandidatesReady(
    config.topics,
    getCandidates,
    async (topic, candidates) => {
      const threadId = opts.threadIds.get(topic.name);
      if (threadId === undefined) {
        logger.warn(
          { event: "llm_skip_topic_no_thread", topic: topic.name },
          "Skipping topic with no Telegram thread id",
        );
        return emptyRankResult();
      }

      const topicCandidates = candidatesForTopic(
        topic,
        candidates,
        sourceTopics,
        config.max_candidates,
      );
      if (topicCandidates.length === 0) {
        logger.warn(
          { event: "llm_skip_topic_no_candidates", topic: topic.name },
          "Skipping topic with no mapped candidates",
        );
        return emptyRankResult();
      }

      try {
        return await rankForTopic(client, topic, topicCandidates, {
          model: opts.model,
          threshold: config.relevance_threshold,
          topN: config.top_n,
          threadId,
          onCharge: opts.onCharge,
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        // OpenAI SDK errors carry the HTTP status and the OpenRouter error
        // body (provider name, upstream message) that err.message drops.
        const apiFields =
          err instanceof OpenAI.APIError
            ? {
                status: err.status,
                api_code: err.code,
                api_error_type: err.type,
                api_error: err.error,
              }
            : {};
        logger.error(
          {
            event: "llm_rank_topic_failed",
            topic: topic.name,
            model: opts.model,
            error,
            ...apiFields,
            stack: err instanceof Error ? err.stack : undefined,
          },
          "Topic ranking failed; continuing with other topics",
        );
        return {
          items: [],
          cost: 0,
          charges: [],
          errors: [{ topic: topic.name, error }],
        };
      }
    },
  );

  const ranked = results.flatMap((r) => r.items);
  const charges = results.flatMap((r) => r.charges);
  const cost = charges.reduce((sum, charge) => sum + charge.cost, 0);
  const errors = results.flatMap((r) => r.errors);

  logger.info(
    {
      event: "llm_rank_done",
      rankedCount: ranked.length,
      topCount: ranked.length,
      perTopic: Object.fromEntries(
        config.topics.map((t) => [
          t.name,
          ranked.filter((i) => i.topic === t.name).length,
        ]),
      ),
      failedTopics: errors.map((e) => e.topic),
      threshold: config.relevance_threshold,
      cost,
      charges: charges.map((charge) => ({
        topic: charge.topic,
        cost: charge.cost,
        generationId: charge.generationId,
      })),
    },
    "Selected top ranked items per topic",
  );

  return { items: ranked, cost, charges, errors };
}

export async function rankItems(
  config: AppConfig,
  candidates: NewsItem[],
  opts: {
    apiKey: string;
    model: string;
    threadIds: Map<string, number>;
    onCharge?: (charge: OpenRouterCharge) => void | Promise<void>;
  },
): Promise<RankResult> {
  if (candidates.length === 0) {
    return emptyRankResult();
  }
  return rankTopics(config, async () => candidates, opts);
}
