import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Bot } from "grammy";
import { dataDir } from "./config/index.ts";
import { fetchAllSources } from "./fetch/index.ts";
import { rankItems } from "./llm/index.ts";
import type { AppConfig, EnvSecrets } from "./lib/schemas.ts";
import { logger } from "./lib/logger.ts";
import type { Store } from "./store/index.ts";
import {
  postItems,
  resolveTopicThreads,
  sendFailureAlert,
} from "./telegram/index.ts";

export type PipelineResult =
  | { ok: true; posted: number; reason?: "no_fresh_candidates" | "none_passed_threshold" }
  | { ok: false; error: string };

function writeRunLog(entry: Record<string, unknown>): void {
  const dir = join(dataDir(), "logs");
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "runs.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
}

export async function runNewsPipeline(opts: {
  bot: Bot;
  store: Store;
  config: AppConfig;
  secrets: EnvSecrets;
}): Promise<PipelineResult> {
  const { bot, store, config, secrets } = opts;
  const started = Date.now();
  mkdirSync(join(dataDir(), "logs"), { recursive: true });
  let totalCost = 0;

  try {
    const threadIds = resolveTopicThreads(
      secrets.telegramGroupId,
      config.topics,
      store,
    );

    const fetched = await fetchAllSources(config);
    const fresh = store.filterNew(fetched);

    if (fresh.length === 0) {
      const summary = {
        event: "run_complete",
        posted: 0,
        duration_ms: Date.now() - started,
        llm_cost: 0,
        reason: "no_fresh_candidates" as const,
      };
      logger.info(summary, "Nothing new to post");
      writeRunLog({ ...summary, at: new Date().toISOString() });
      return { ok: true, posted: 0, reason: "no_fresh_candidates" };
    }

    const { items: ranked, cost } = await rankItems(config, fresh, {
      apiKey: secrets.openRouterApiKey,
      model: secrets.openRouterModel,
      threadIds,
    });
    totalCost = cost;

    if (ranked.length === 0) {
      const summary = {
        event: "run_complete",
        posted: 0,
        duration_ms: Date.now() - started,
        llm_cost: totalCost,
        reason: "none_passed_threshold" as const,
      };
      logger.info(summary, "No items passed relevance threshold");
      writeRunLog({ ...summary, at: new Date().toISOString() });
      return { ok: true, posted: 0, reason: "none_passed_threshold" };
    }

    const posted = await postItems(
      bot,
      secrets.telegramGroupId,
      ranked,
      (group) => {
        for (const item of group) {
          store.markPosted(item);
          for (const related of item.relatedItems) {
            store.markPosted(related);
          }
        }
      },
    );

    const summary = {
      event: "run_complete",
      posted,
      duration_ms: Date.now() - started,
      llm_cost: totalCost,
      per_topic: Object.fromEntries(
        config.topics.map((t) => [
          t.name,
          ranked.filter((i) => i.topic === t.name).length,
        ]),
      ),
    };
    logger.info(summary, "Run complete");
    writeRunLog({
      ...summary,
      at: new Date().toISOString(),
      items: ranked.map((i) => ({
        id: i.id,
        title: i.title,
        topic: i.topic,
        score: i.score,
        related: i.relatedItems.map((related) => ({
          id: related.id,
          title: related.title,
          source: related.source,
        })),
      })),
    });

    return { ok: true, posted };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const summary = {
      event: "run_failed",
      error: message,
      duration_ms: Date.now() - started,
      llm_cost: totalCost,
    };
    logger.error(summary, "Run failed");
    writeRunLog({ ...summary, at: new Date().toISOString() });

    if (secrets.telegramAlertChatId) {
      await sendFailureAlert(bot, secrets.telegramAlertChatId, message);
    }

    return { ok: false, error: message };
  }
}
