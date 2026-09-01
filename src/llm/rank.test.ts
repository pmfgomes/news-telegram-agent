import { describe, expect, test } from "bun:test";
import { EventType, type StreamChunk } from "@tanstack/ai";
import { fetchItemsForTopic, type SourceFetches } from "../fetch/index.ts";
import type { AppConfig, NewsItem, TopicConfig } from "../lib/types.ts";
import {
  buildRankChatRequest,
  buildRankModelOptions,
  collectRankStream,
  mapTopicsAsCandidatesReady,
  parseRankings,
  RANK_MAX_TOKENS,
  RANK_REASONING_MAX_TOKENS,
  RankParseError,
  RankStreamError,
} from "./rank.ts";

const portugal: TopicConfig = {
  name: "Portugal",
  interest: "Portugal news",
  ranking_mode: "latest",
  telegram_thread_id: 1,
};

const world: TopicConfig = {
  name: "World",
  interest: "World news",
  ranking_mode: "latest",
  telegram_thread_id: 2,
};

const config: AppConfig = {
  timezone: "Europe/Lisbon",
  latest_per_source: 10,
  max_candidates: 60,
  top_n: 10,
  relevance_threshold: 0.6,
  topics: [portugal, world],
  sources: [
    {
      name: "Portugal source",
      topics: ["Portugal"],
      rss_url: "https://example.com/portugal.xml",
    },
    {
      name: "World source",
      topics: ["World"],
      rss_url: "https://example.com/world.xml",
    },
  ],
};

function news(id: string, source: string): NewsItem {
  return {
    id,
    title: id,
    link: `https://example.com/${id}`,
    source,
    publishedAt: null,
  };
}

async function* fakeStream(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe("topic fetch and ranking concurrency", () => {
  test("processes a ready topic without waiting for unrelated sources", async () => {
    const portugalFetch = Promise.withResolvers<NewsItem[]>();
    const worldFetch = Promise.withResolvers<NewsItem[]>();
    const portugalProcessing = Promise.withResolvers<void>();
    let worldStarted = false;

    const sourceFetches: SourceFetches = new Map([
      ["Portugal source", portugalFetch.promise],
      ["World source", worldFetch.promise],
    ]);

    const run = mapTopicsAsCandidatesReady(
      config.topics,
      (topic) => fetchItemsForTopic(config, topic, sourceFetches),
      async (topic, candidates) => {
        if (topic.name === "Portugal") {
          portugalProcessing.resolve();
        }
        if (topic.name === "World") {
          worldStarted = true;
        }
        return { topic: topic.name, count: candidates.length };
      },
    );

    portugalFetch.resolve([news("pt-1", "Portugal source")]);
    await portugalProcessing.promise;

    expect(worldStarted).toBeFalse();

    worldFetch.resolve([news("world-1", "World source")]);
    await expect(run).resolves.toEqual([
      { topic: "Portugal", count: 1 },
      { topic: "World", count: 1 },
    ]);
    expect(worldStarted).toBeTrue();
  });
});

describe("buildRankChatRequest", () => {
  test("caps completion budget and enables response healing with usage accounting", () => {
    const request = buildRankChatRequest({
      prompt: "rank these candidates",
    });
    const options = buildRankModelOptions();

    expect(request.modelOptions).toEqual(options);
    expect(options.maxCompletionTokens).toBe(RANK_MAX_TOKENS);
    expect(options.reasoning).toEqual({ effort: "low" });
    expect(options.responseFormat).toEqual({ type: "json_object" });
    expect(options.plugins).toEqual([{ id: "response-healing" }]);
    expect(options.streamOptions).toEqual({ includeUsage: true });
    expect(request.systemPrompt).toBe(
      "You are a precise news clustering and ranking assistant. Reply with JSON only.",
    );
    expect(request.userPrompt).toBe("rank these candidates");
    expect(RANK_REASONING_MAX_TOKENS).toBeLessThan(RANK_MAX_TOKENS);
  });
});

describe("collectRankStream", () => {
  test("accumulates assistant text and maps billed usage from RUN_FINISHED", async () => {
    const collected = await collectRankStream(
      fakeStream([
        {
          type: EventType.RUN_STARTED,
          runId: "run-123",
          threadId: "thread-1",
          timestamp: Date.now(),
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "msg-1",
          delta: '{"rankings":',
          content: '{"rankings":',
          timestamp: Date.now(),
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "msg-1",
          delta: "[]}",
          content: '{"rankings":[]}',
          timestamp: Date.now(),
        },
        {
          type: EventType.RUN_FINISHED,
          runId: "run-123",
          threadId: "thread-1",
          model: "google/gemini-2.5-flash-lite",
          finishReason: "stop",
          timestamp: Date.now(),
          usage: {
            promptTokens: 120,
            completionTokens: 40,
            totalTokens: 160,
            cost: 0.00042,
            costDetails: { upstreamCost: 0.0004 },
          },
        },
      ]),
    );

    expect(collected.content).toBe('{"rankings":[]}');
    expect(collected.runId).toBe("run-123");
    expect(collected.servedModel).toBe("google/gemini-2.5-flash-lite");
    expect(collected.finishReason).toBe("stop");
    expect(collected.promptTokens).toBe(120);
    expect(collected.completionTokens).toBe(40);
    expect(collected.totalTokens).toBe(160);
    expect(collected.cost).toBe(0.00042);
    expect(collected.upstreamInferenceCost).toBe(0.0004);
    expect(collected.events).toHaveLength(4);
  });

  test("preserves length finish reason for truncated parse errors", async () => {
    const collected = await collectRankStream(
      fakeStream([
        {
          type: EventType.RUN_STARTED,
          runId: "run-length",
          threadId: "thread-1",
          timestamp: Date.now(),
        },
        {
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "msg-1",
          delta: '{"rankings":[{"id":"a"',
          content: '{"rankings":[{"id":"a"',
          timestamp: Date.now(),
        },
        {
          type: EventType.RUN_FINISHED,
          runId: "run-length",
          threadId: "thread-1",
          finishReason: "length",
          timestamp: Date.now(),
          usage: {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
            cost: 0.01,
          },
        },
      ]),
    );

    expect(collected.finishReason).toBe("length");
    expect(collected.content).toBe('{"rankings":[{"id":"a"');
  });

  test("throws RankStreamError with provider rawEvent on RUN_ERROR", async () => {
    await expect(
      collectRankStream(
        fakeStream([
          {
            type: EventType.RUN_ERROR,
            message: "Provider returned error",
            code: "provider_error",
            rawEvent: { provider: "anthropic", detail: "rate limited" },
            timestamp: Date.now(),
          },
        ]),
      ),
    ).rejects.toMatchObject({
      name: "RankStreamError",
      message: "Provider returned error",
      code: "provider_error",
      rawEvent: { provider: "anthropic", detail: "rate limited" },
    });

    try {
      await collectRankStream(
        fakeStream([
          {
            type: EventType.RUN_ERROR,
            message: "Provider returned error",
            code: "provider_error",
            timestamp: Date.now(),
          },
        ]),
      );
    } catch (err) {
      expect(err).toBeInstanceOf(RankStreamError);
    }
  });
});

describe("parseRankings", () => {
  const row = {
    id: "Wired::abc",
    related_ids: ["The Verge::def"],
    topic: "Technology",
    score: 0.91,
    summary: "A Zoom bug let callers take over other devices.",
  };
  const json = JSON.stringify({ rankings: [row] });

  test("parses a bare JSON object", () => {
    expect(parseRankings(json)).toEqual([row]);
  });

  test("parses markdown-fenced JSON", () => {
    expect(parseRankings(`\`\`\`json\n${json}\n\`\`\``)).toEqual([row]);
  });

  test("parses JSON wrapped in prose", () => {
    expect(parseRankings(`Here is the ranking:\n${json}\nThanks.`)).toEqual([row]);
  });

  test("parses array-of-parts content", () => {
    expect(parseRankings([{ type: "text", text: json }])).toEqual([row]);
  });

  test("strips a BOM", () => {
    expect(parseRankings(`\uFEFF${json}`)).toEqual([row]);
  });

  test("rejects empty content", () => {
    expect(() => parseRankings("")).toThrow("empty response");
  });

  test("rejects whitespace-only content from truncated reasoning", () => {
    expect(() => parseRankings(" ")).toThrow("empty response");
  });

  test("rejects truncated JSON", () => {
    expect(() => parseRankings('{"rankings":[{"id":"a"')).toThrow("Failed to parse LLM JSON");
  });

  test("labels each failure with the stage that rejected it", () => {
    const stageOf = (input: string): string | null => {
      try {
        parseRankings(input);
        return null;
      } catch (err) {
        return err instanceof RankParseError ? err.stage : null;
      }
    };
    expect(stageOf("")).toBe("empty_content");
    expect(stageOf('{"rankings":[{"id":"a"')).toBe("no_json_object");
    expect(stageOf('{"rankings":[}')).toBe("invalid_json");
    expect(stageOf('{"rankings":[{"id":""}]}')).toBe("schema_mismatch");
  });
});
