import * as cheerio from "cheerio";
import Parser from "rss-parser";
import { logger } from "../lib/logger.ts";
import type {
  AppConfig,
  NewsItem,
  SourceConfig,
  TopicConfig,
} from "../lib/types.ts";

const USER_AGENT =
  "Mozilla/5.0 (compatible; news-telegram-agent/1.0; +https://github.com/pmfgomes/news-telegram-agent)";
const FETCH_TIMEOUT_MS = 15_000;
const SOURCE_DELAY_MS = 250;

const rssParser = new Parser({
  timeout: FETCH_TIMEOUT_MS,
  headers: {
    "User-Agent": USER_AGENT,
    Accept: "application/rss+xml, application/xml, text/xml, */*",
  },
});

const RSS_FETCH_HEADERS = {
  "User-Agent": USER_AGENT,
  Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
  "Accept-Language": "pt-PT,pt;q=0.9,en;q=0.8",
} as const;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Stable link for dedupe: drop hash and common tracking query params. */
function canonicalizeLink(raw: string): string {
  try {
    const url = new URL(raw.trim());
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (
        key.startsWith("utm_") ||
        key === "at_medium" ||
        key === "at_campaign" ||
        key === "at_bbc_team" ||
        key === "ns_mchannel" ||
        key === "ns_source" ||
        key === "ocid"
      ) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return raw.trim();
  }
}

function canonicalId(source: string, link: string, guid?: string): string {
  const base = canonicalizeLink((guid || link).trim());
  return `${source}::${base}`;
}

function selectLatest(items: NewsItem[], limit: number): NewsItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const aTime = a.item.publishedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
      const bTime = b.item.publishedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
      return bTime - aTime || a.index - b.index;
    })
    .slice(0, limit)
    .map(({ item }) => item);
}

async function fetchText(
  url: string,
  headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "*/*" },
): Promise<{ status: number; body: string; contentType: string | null }> {
  const res = await fetch(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const body = await res.text();
  return {
    status: res.status,
    body,
    contentType: res.headers.get("content-type"),
  };
}

/** Strip BOM / leading junk so XML parsers accept feeds that still look like HTML by Content-Type. */
function normalizeFeedBody(body: string): string {
  const trimmed = body.replace(/^\uFEFF/, "").trimStart();
  const xmlStart = trimmed.search(/<(?:\?xml|rss|feed)\b/i);
  if (xmlStart > 0) return trimmed.slice(xmlStart);
  return trimmed;
}

function assertRssBody(body: string, url: string, contentType: string | null): void {
  const normalized = normalizeFeedBody(body);
  if (!/^<(?:\?xml|rss|feed)\b/i.test(normalized)) {
    throw new Error(
      `Expected RSS/Atom XML from ${url}, got ${contentType ?? "unknown"} ` +
        `(body starts with ${JSON.stringify(normalized.slice(0, 80))})`,
    );
  }
}

async function fetchRss(source: SourceConfig): Promise<NewsItem[]> {
  const url = source.rss_url!;
  logger.info({ event: "fetch_start", source: source.name, url, kind: "rss" }, "Fetching RSS");

  const { status, body, contentType } = await fetchText(url, { ...RSS_FETCH_HEADERS });
  if (status >= 400) {
    throw new Error(`HTTP ${status} for ${url}`);
  }

  const feedBody = normalizeFeedBody(body);
  assertRssBody(feedBody, url, contentType);

  const feed = await rssParser.parseString(feedBody);
  const items: NewsItem[] = [];

  for (const entry of feed.items ?? []) {
    const link = canonicalizeLink(entry.link?.trim() ?? "");
    const title = entry.title?.trim();
    if (!link || !title) continue;

    const publishedAt =
      parseDate(entry.isoDate) ?? parseDate(entry.pubDate) ?? null;

    items.push({
      id: canonicalId(source.name, link, entry.guid),
      title,
      link,
      source: source.name,
      publishedAt,
      summary: entry.contentSnippet?.trim() || entry.summary?.trim() || undefined,
    });
  }

  logger.info(
    {
      event: "fetch_ok",
      source: source.name,
      url,
      kind: "rss",
      itemCount: items.length,
    },
    "RSS fetch ok",
  );
  return items;
}

async function fetchScrape(source: SourceConfig): Promise<NewsItem[]> {
  const url = source.url!;
  const selector = source.scrape_selector!;
  logger.info(
    { event: "fetch_start", source: source.name, url, kind: "scrape", selector },
    "Fetching HTML scrape",
  );

  const { status, body } = await fetchText(url);
  if (status >= 400) {
    throw new Error(`HTTP ${status} for ${url}`);
  }

  const $ = cheerio.load(body);
  const items: NewsItem[] = [];
  const seen = new Set<string>();

  $(selector).each((_, el) => {
    const anchor = $(el).is("a") ? $(el) : $(el).find("a").first();
    const title = anchor.text().trim() || $(el).text().trim();
    let href = anchor.attr("href")?.trim();
    if (!title || !href) return;

    try {
      href = canonicalizeLink(new URL(href, url).toString());
    } catch {
      return;
    }
    if (seen.has(href)) return;
    seen.add(href);

    items.push({
      id: canonicalId(source.name, href),
      title,
      link: href,
      source: source.name,
      publishedAt: null,
    });
  });

  logger.info(
    {
      event: "fetch_ok",
      source: source.name,
      url,
      kind: "scrape",
      itemCount: items.length,
    },
    "Scrape fetch ok",
  );
  return items;
}

async function fetchSource(
  source: SourceConfig,
  latestPerSource: number,
): Promise<NewsItem[]> {
  let items: NewsItem[];

  if (source.rss_url) {
    try {
      items = await fetchRss(source);
    } catch (err) {
      logger.warn(
        {
          event: "fetch_fail",
          source: source.name,
          url: source.rss_url,
          kind: "rss",
          error: String(err),
        },
        "RSS failed",
      );
      if (source.url && source.scrape_selector) {
        items = await fetchScrape(source);
      } else {
        throw err;
      }
    }
  } else {
    items = await fetchScrape(source);
  }

  const latest = selectLatest(items, latestPerSource);
  logger.info(
    {
      event: "fetch_latest",
      source: source.name,
      topics: source.topics,
      availableCount: items.length,
      selectedCount: latest.length,
    },
    "Selected latest source articles",
  );
  return latest;
}

export type SourceFetches = ReadonlyMap<string, Promise<NewsItem[]>>;

function normalizeItems(items: NewsItem[], topic?: string): NewsItem[] {
  const bySourceAndLink = new Map<string, NewsItem>();
  for (const item of items) {
    const key = `${item.source}\u0000${item.link}`;
    if (!bySourceAndLink.has(key)) bySourceAndLink.set(key, item);
  }

  const unique = [...bySourceAndLink.values()];
  logger.info(
    {
      event: "fetch_normalize",
      rawCount: items.length,
      uniqueCount: unique.length,
      ...(topic ? { topic } : {}),
    },
    "Normalized fetch pool",
  );
  return unique;
}

/**
 * Start every configured source fetch immediately (with the existing stagger).
 * Consumers can await only the sources needed by one topic.
 */
export function startSourceFetches(config: AppConfig): SourceFetches {
  return new Map(
    config.sources.map((source, index) => {
      const promise = (async (): Promise<NewsItem[]> => {
        if (index > 0) await sleep(SOURCE_DELAY_MS * index);
        try {
          return await fetchSource(source, config.latest_per_source);
        } catch (err) {
          logger.error(
            {
              event: "fetch_fail",
              source: source.name,
              error: String(err),
            },
            "Source failed; continuing",
          );
          return [];
        }
      })();
      const entry: readonly [string, Promise<NewsItem[]>] = [
        source.name,
        promise,
      ];
      return entry;
    }),
  );
}

export async function fetchItemsForTopic(
  config: AppConfig,
  topic: TopicConfig,
  sourceFetches: SourceFetches,
): Promise<NewsItem[]> {
  const topicName = topic.name.toLowerCase();
  const relevantSources = config.sources.filter((source) =>
    source.topics.some((name) => name.toLowerCase() === topicName),
  );
  const batches = await Promise.all(
    relevantSources.map((source) => {
      const fetchPromise = sourceFetches.get(source.name);
      if (!fetchPromise) {
        throw new Error(`Source fetch was not started: ${source.name}`);
      }
      return fetchPromise;
    }),
  );
  return normalizeItems(batches.flat(), topic.name);
}

export async function fetchAllSources(config: AppConfig): Promise<NewsItem[]> {
  const sourceFetches = startSourceFetches(config);
  const items = (
    await Promise.all(
      config.sources.map((source) => {
        const fetchPromise = sourceFetches.get(source.name);
        if (!fetchPromise) {
          throw new Error(`Source fetch was not started: ${source.name}`);
        }
        return fetchPromise;
      }),
    )
  ).flat();

  const unique = normalizeItems(items);
  logger.info(
    {
      event: "fetch_all_done",
      uniqueCount: unique.length,
      latestPerSource: config.latest_per_source,
    },
    "Fetched all configured sources",
  );
  return unique;
}
