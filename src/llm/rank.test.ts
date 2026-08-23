import { describe, expect, test } from "bun:test";
import { fetchItemsForTopic, type SourceFetches } from "../fetch/index.ts";
import type {
  AppConfig,
  NewsItem,
  TopicConfig,
} from "../lib/types.ts";
import { mapTopicsAsCandidatesReady, parseRankings } from "./rank.ts";

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
    expect(parseRankings(`Here is the ranking:\n${json}\nThanks.`)).toEqual([
      row,
    ]);
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

  test("rejects truncated JSON", () => {
    expect(() => parseRankings('{"rankings":[{"id":"a"')).toThrow(
      "Failed to parse LLM JSON",
    );
  });
});
