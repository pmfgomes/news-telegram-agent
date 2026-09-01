import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { dataDir } from "../config/index.ts";
import { logger } from "../lib/logger.ts";
import type { NewsItem, TopicConfig } from "../lib/types.ts";

export type PostedRecord = {
  guid: string;
  url: string;
  content_hash: string;
  posted_at: string;
};

export type StoredTopic = {
  channel_id: string;
  topic_name: string;
  thread_id: number;
  interest: string;
  updated_at: string;
};

function canonicalizeLink(raw: string): string {
  try {
    const url = new URL(raw.trim());
    url.hash = "";
    for (const key of Array.from(url.searchParams.keys())) {
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

export class Store {
  private db: Database;

  constructor(dbPath = join(dataDir(), "news.db")) {
    mkdirSync(dataDir(), { recursive: true });
    this.db = new Database(dbPath, { create: true });
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS posted_items (
        guid TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        posted_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_posted_url ON posted_items(url);
      CREATE INDEX IF NOT EXISTS idx_posted_hash ON posted_items(content_hash);

      CREATE TABLE IF NOT EXISTS telegram_topics (
        channel_id TEXT NOT NULL,
        topic_name TEXT NOT NULL,
        thread_id INTEGER NOT NULL,
        interest TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (channel_id, topic_name)
      );
    `);

    // Older DBs may lack interest column.
    const cols = this.db.query(`PRAGMA table_info(telegram_topics)`).all() as Array<{
      name: string;
    }>;
    if (!cols.some((c) => c.name === "interest")) {
      this.db.exec(`ALTER TABLE telegram_topics ADD COLUMN interest TEXT NOT NULL DEFAULT ''`);
    }

    logger.info({ event: "store_ready", dbPath }, "SQLite store ready");
  }

  static contentHash(item: Pick<NewsItem, "title" | "link">): string {
    return createHash("sha256")
      .update(`${item.title.trim().toLowerCase()}|${canonicalizeLink(item.link)}`)
      .digest("hex");
  }

  isPosted(item: NewsItem): boolean {
    const hash = Store.contentHash(item);
    const url = canonicalizeLink(item.link);
    const exact = this.db
      .query(
        `SELECT 1 AS ok FROM posted_items
         WHERE guid = ? OR url = ? OR url = ? OR content_hash = ?
         LIMIT 1`,
      )
      .get(item.id, item.link, url, hash) as { ok: number } | null;
    if (exact) return true;

    // Legacy rows may still include tracking params or #fragments.
    try {
      const path = new URL(url).pathname;
      if (path.length > 1) {
        const legacy = this.db
          .query(
            `SELECT 1 AS ok FROM posted_items
             WHERE url LIKE ? OR guid LIKE ?
             LIMIT 1`,
          )
          .get(`%${path}%`, `%${path}%`) as { ok: number } | null;
        if (legacy) return true;
      }
    } catch {
      // ignore invalid urls
    }

    return false;
  }

  filterNew(items: NewsItem[]): NewsItem[] {
    const fresh = items.filter((item) => !this.isPosted(item));
    logger.info(
      {
        event: "dedupe",
        candidatesIn: items.length,
        candidatesOut: fresh.length,
      },
      "Deduped against posted store",
    );
    return fresh;
  }

  markPosted(item: NewsItem): void {
    const postedAt = new Date().toISOString();
    const url = canonicalizeLink(item.link);
    this.db
      .query(
        `INSERT OR REPLACE INTO posted_items (guid, url, content_hash, posted_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(item.id, url, Store.contentHash(item), postedAt);
  }

  getTopic(channelId: string, topicName: string): StoredTopic | null {
    const row = this.db
      .query(
        `SELECT channel_id, topic_name, thread_id, interest, updated_at
         FROM telegram_topics
         WHERE channel_id = ? AND topic_name = ?
         LIMIT 1`,
      )
      .get(channelId, topicName) as StoredTopic | null;
    return row ?? null;
  }

  getTopicThreadId(channelId: string, topicName: string): number | null {
    return this.getTopic(channelId, topicName)?.thread_id ?? null;
  }

  upsertTopic(channelId: string, topic: TopicConfig, threadId: number): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO telegram_topics
           (channel_id, topic_name, thread_id, interest, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(channelId, topic.name, threadId, topic.interest, new Date().toISOString());
  }

  /** Keep compatibility with older call sites. */
  setTopicThreadId(channelId: string, topicName: string, threadId: number): void {
    this.upsertTopic(
      channelId,
      { name: topicName, interest: "", ranking_mode: "filter" },
      threadId,
    );
  }

  deleteTopic(channelId: string, topicName: string): void {
    this.db
      .query(`DELETE FROM telegram_topics WHERE channel_id = ? AND topic_name = ?`)
      .run(channelId, topicName);
  }

  listTopics(channelId: string): StoredTopic[] {
    return this.db
      .query(
        `SELECT channel_id, topic_name, thread_id, interest, updated_at
         FROM telegram_topics
         WHERE channel_id = ?
         ORDER BY topic_name`,
      )
      .all(channelId) as StoredTopic[];
  }

  close(): void {
    this.db.close();
  }
}
