import type { Context } from "grammy";
import { dataDir, loadConfig, loadSecrets } from "./config/index.ts";
import { logger } from "./lib/logger.ts";
import { runNewsPipeline } from "./pipeline.ts";
import { Store } from "./store/index.ts";
import { createBot, telegramErrorFields } from "./telegram/index.ts";
import { formatPipelineReply } from "./telegram/replies.ts";

function isConfiguredGroup(chat: Context["chat"], groupId: string): boolean {
  if (!chat) return false;
  const configured = groupId.trim();
  if (configured.startsWith("@")) {
    const username = configured.slice(1).toLowerCase();
    return (chat.username?.toLowerCase() ?? "") === username;
  }
  return String(chat.id) === configured;
}

async function isGroupAdmin(ctx: Context): Promise<boolean> {
  if (ctx.senderChat?.id !== undefined && ctx.chat?.id !== undefined) {
    if (ctx.senderChat.id === ctx.chat.id) return true;
  }

  try {
    const author = await ctx.getAuthor();
    return author.status === "creator" || author.status === "administrator";
  } catch (err) {
    logger.warn(
      { event: "admin_check_failed", ...telegramErrorFields(err) },
      "Failed to check group admin status",
    );
    return false;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const secrets = loadSecrets();
  const bot = createBot(secrets.telegramBotToken);
  const store = new Store();
  let newsRunning = false;

  bot.command("news", async (ctx) => {
    if (!isConfiguredGroup(ctx.chat, secrets.telegramGroupId)) {
      return;
    }

    if (!(await isGroupAdmin(ctx))) {
      await ctx.reply("Only group admins can run /news.");
      return;
    }

    if (newsRunning) {
      await ctx.reply("Already getting the news. Please wait.");
      return;
    }

    newsRunning = true;
    try {
      await ctx.reply("Getting the news…");
      const result = await runNewsPipeline({
        bot,
        store,
        config,
        secrets,
        messageThreadId: ctx.message?.message_thread_id,
      });
      await ctx.reply(formatPipelineReply(result));
    } finally {
      newsRunning = false;
    }
  });

  // Without this, an error thrown while handling an update (e.g. a failed
  // reply) crashes long polling with a bare console stack instead of a log.
  bot.catch((err) => {
    logger.error(
      {
        event: "bot_update_failed",
        update_id: err.ctx.update.update_id,
        chat_id: err.ctx.chat?.id,
        ...telegramErrorFields(err.error),
      },
      "Unhandled error while handling Telegram update",
    );
  });

  await bot.api.setMyCommands([
    { command: "news", description: "Fetch news and send HTML newsletter" },
  ]);

  process.once("SIGINT", () => bot.stop());
  process.once("SIGTERM", () => bot.stop());

  logger.info(
    { event: "bot_starting", dataPath: dataDir() },
    "Starting news bot (long polling)",
  );

  try {
    await bot.start({
      onStart: () => {
        logger.info("Bot is running; waiting for /news");
      },
    });
  } finally {
    store.close();
    logger.info({ event: "bot_stopped" }, "Bot stopped");
  }
}

// Last-resort handlers: log through pino before the container dies, so a
// crash leaves evidence in `docker compose logs` instead of exiting silently.
process.on("uncaughtException", (err) => {
  logger.fatal(
    { event: "uncaught_exception", error: err.message, stack: err.stack },
    "Uncaught exception; exiting",
  );
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.fatal(
    {
      event: "unhandled_rejection",
      error: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
    },
    "Unhandled promise rejection; exiting",
  );
  process.exit(1);
});

try {
  await main();
} catch (err) {
  logger.fatal(
    {
      event: "startup_failed",
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    },
    "Bot crashed during startup or polling",
  );
  process.exit(1);
}
