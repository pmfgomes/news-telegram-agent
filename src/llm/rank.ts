import OpenAI from "openai";
import { ZodError } from "zod";
import { logger } from "../lib/logger.ts";
import {
  formatZodError,
  llmRankResponseSchema,
  openRouterUsageSchema,
  type LlmRankRow,
} from "../lib/schemas.ts";
import type { AppConfig, NewsItem, RankedItem, TopicConfig } from "../lib/types.ts";

export type RankResult = {
  items: RankedItem[];
  /** Exact cost from OpenRouter usage.cost (credits charged). */
  cost: number;
};

export type TopicCandidatesProvider = (
  topic: TopicConfig,
) => Promise<NewsItem[]>;

function emptyRankResult(): RankResult {
  return { items: [], cost: 0 };
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

function parseRankings(content: string): LlmRankRow[] {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (err) {
    throw new Error(`Failed to parse LLM JSON: ${String(err)}`);
  }

  try {
    return llmRankResponseSchema.parse(json).rankings;
  } catch (err) {
    if (err instanceof ZodError) {
      throw new Error(`Invalid LLM ranking JSON:\n${formatZodError(err)}`);
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

  const completion = await client.chat.completions.create({
    model: opts.model,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are a precise news clustering and ranking assistant. Reply with JSON only.",
      },
      { role: "user", content: buildPrompt(topic, candidates, opts.topN) },
    ],
    usage: { include: true },
  } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming);

  const latencyMs = Date.now() - started;
  const content = completion.choices[0]?.message?.content ?? "{}";
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
      topic: topic.name,
      generation_id: completion.id,
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

  const rankings = parseRankings(content)
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

  return { items: selected, cost };
}

export async function rankTopics(
  config: AppConfig,
  getCandidates: TopicCandidatesProvider,
  opts: {
    apiKey: string;
    model: string;
    threadIds: Map<string, number>;
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

      return rankForTopic(client, topic, topicCandidates, {
        model: opts.model,
        threshold: config.relevance_threshold,
        topN: config.top_n,
        threadId,
      });
    },
  );

  const ranked = results.flatMap((r) => r.items);
  const cost = results.reduce((sum, r) => sum + r.cost, 0);

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
      threshold: config.relevance_threshold,
      cost,
    },
    "Selected top ranked items per topic",
  );

  return { items: ranked, cost };
}

export async function rankItems(
  config: AppConfig,
  candidates: NewsItem[],
  opts: {
    apiKey: string;
    model: string;
    threadIds: Map<string, number>;
  },
): Promise<RankResult> {
  if (candidates.length === 0) {
    return { items: [], cost: 0 };
  }
  return rankTopics(config, async () => candidates, opts);
}
