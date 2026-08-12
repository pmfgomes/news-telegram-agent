import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir, loadConfig, loadSecrets } from "./config/index.ts";
import { fetchAllSources } from "./fetch/index.ts";
import { rankItems } from "./llm/index.ts";
import { logger } from "./lib/logger.ts";
import { Store } from "./store/index.ts";
import {
  createBot,
  postItems,
  resolveTopicThreads,
  sendFailureAlert,
} from "./telegram/index.ts";

function writeRunLog(entry: Record<string, unknown>): void {
  const dir = join(dataDir(), "logs");
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "runs.jsonl"), `${JSON.stringify(entry)}\n`, "utf8");
}

async function run(): Promise<void> {
  const started = Date.now();
  mkdirSync(join(dataDir(), "logs"), { recursive: true });

  let alertBot: ReturnType<typeof createBot> | null = null;
  let alertChat: string | undefined;
  let totalCost = 0;

  try {
    const config = loadConfig();
    const secrets = loadSecrets();
    alertBot = createBot(secrets.telegramBotToken);
    alertChat = secrets.telegramAlertChatId;

    const store = new Store();
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
          reason: "no_fresh_candidates",
        };
        logger.info(summary, "Nothing new to post");
        writeRunLog({ ...summary, at: new Date().toISOString() });
        return;
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
          reason: "none_passed_threshold",
        };
        logger.info(summary, "No items passed relevance threshold");
        writeRunLog({ ...summary, at: new Date().toISOString() });
        return;
      }

      const posted = await postItems(
        alertBot,
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
    } finally {
      store.close();
    }
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

    if (alertBot && alertChat) {
      await sendFailureAlert(alertBot, alertChat, message);
    }

    process.exitCode = 1;
  }
}

await run();
