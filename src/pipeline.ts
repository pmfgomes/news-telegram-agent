import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Bot } from "grammy";
import { dataDir } from "./config/index.ts";
import {
  fetchItemsForTopic,
  startSourceFetches,
} from "./fetch/index.ts";
import { rankTopics } from "./llm/index.ts";
import type { OpenRouterCharge } from "./llm/rank.ts";
import type { AppConfig, EnvSecrets } from "./lib/schemas.ts";
import { logger } from "./lib/logger.ts";
import type { Store } from "./store/index.ts";
import {
  postNewsletter,
  resolveTopicThreads,
  sendFailureAlert,
} from "./telegram/index.ts";

export type PipelineResult =
  | {
      ok: true;
      posted: number;
      reason?: "no_fresh_candidates" | "none_passed_threshold";
      rankingFailedTopics: string[];
      charges: OpenRouterCharge[];
    }
  | { ok: false; error: string; charges: OpenRouterCharge[] };

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
  messageThreadId?: number;
  onOpenRouterCharge?: (charge: OpenRouterCharge) => void | Promise<void>;
}): Promise<PipelineResult> {
  const { bot, store, config, secrets } = opts;
  const started = Date.now();
  mkdirSync(join(dataDir(), "logs"), { recursive: true });
  let totalCost = 0;
  const charges: OpenRouterCharge[] = [];

  try {
    const threadIds = resolveTopicThreads(
      secrets.telegramGroupId,
      config.topics,
      store,
    );

    const sourceFetches = startSourceFetches(config);
    let hadFreshCandidates = false;
    const { items: ranked, cost, errors, charges: rankedCharges } = await rankTopics(
      config,
      async (topic) => {
        const fetched = await fetchItemsForTopic(
          config,
          topic,
          sourceFetches,
        );
        const fresh = store.filterNew(fetched);
        if (fresh.length > 0) hadFreshCandidates = true;
        logger.info(
          {
            event: "topic_candidates_ready",
            topic: topic.name,
            fetched: fetched.length,
            fresh: fresh.length,
          },
          "Topic candidates ready for ranking",
        );
        return fresh;
      },
      {
        apiKey: secrets.openRouterApiKey,
        model: secrets.openRouterModel,
        threadIds,
        onCharge: async (charge) => {
          charges.push(charge);
          try {
            await opts.onOpenRouterCharge?.(charge);
          } catch (err) {
            logger.warn(
              {
                event: "openrouter_charge_report_failed",
                topic: charge.topic,
                error: String(err),
              },
              "Failed to report OpenRouter charge to Telegram",
            );
          }
        },
      },
    );
    totalCost = cost;
    const billedCharges =
      rankedCharges.length > 0 ? rankedCharges : [...charges];
    const rankingFailedTopics = errors.map((error) => error.topic);

    if (!hadFreshCandidates) {
      const summary = {
        event: "run_complete",
        posted: 0,
        duration_ms: Date.now() - started,
        llm_cost: 0,
        llm_charges: billedCharges,
        reason: "no_fresh_candidates" as const,
      };
      logger.info(summary, "Nothing new to post");
      writeRunLog({ ...summary, at: new Date().toISOString() });
      return {
        ok: true,
        posted: 0,
        reason: "no_fresh_candidates",
        rankingFailedTopics,
        charges: billedCharges,
      };
    }

    if (ranked.length === 0) {
      if (errors.length > 0) {
        throw new Error(
          errors.map((error) => `${error.topic}: ${error.error}`).join("; "),
        );
      }
      const summary = {
        event: "run_complete",
        posted: 0,
        duration_ms: Date.now() - started,
        llm_cost: totalCost,
        llm_charges: billedCharges,
        reason: "none_passed_threshold" as const,
      };
      logger.info(summary, "No items passed relevance threshold");
      writeRunLog({ ...summary, at: new Date().toISOString() });
      return {
        ok: true,
        posted: 0,
        reason: "none_passed_threshold",
        rankingFailedTopics,
        charges: billedCharges,
      };
    }

    const posted = await postNewsletter(bot, secrets.telegramGroupId, {
      topics: config.topics.map((topic) => topic.name),
      items: ranked,
      messageThreadId: opts.messageThreadId,
      cost: totalCost,
      onPosted: (items) => {
        for (const item of items) {
          store.markPosted(item);
          for (const related of item.relatedItems) {
            store.markPosted(related);
          }
        }
      },
    });

    const summary = {
      event: "run_complete",
      posted,
      duration_ms: Date.now() - started,
      llm_cost: totalCost,
      llm_charges: billedCharges,
      output: "newsletter_html",
      ranking_failed_topics: rankingFailedTopics,
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

    return { ok: true, posted, rankingFailedTopics, charges: billedCharges };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const summary = {
      event: "run_failed",
      error: message,
      duration_ms: Date.now() - started,
      llm_cost: totalCost,
      llm_charges: charges,
    };
    logger.error(summary, "Run failed");
    writeRunLog({ ...summary, at: new Date().toISOString() });

    if (secrets.telegramAlertChatId) {
      await sendFailureAlert(bot, secrets.telegramAlertChatId, message);
    }

    return { ok: false, error: message, charges };
  }
}
