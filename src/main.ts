import type { Context } from "grammy";
import { dataDir, loadConfig, loadSecrets } from "./config/index.ts";
import { logger } from "./lib/logger.ts";
import { runNewsPipeline } from "./pipeline.ts";
import { Store } from "./store/index.ts";
import { createBot } from "./telegram/index.ts";
import {
  formatOpenRouterChargeLine,
  formatPipelineReply,
} from "./telegram/replies.ts";

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
      { event: "admin_check_failed", error: String(err) },
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
      let chargeReports = Promise.resolve();
      const result = await runNewsPipeline({
        bot,
        store,
        config,
        secrets,
        messageThreadId: ctx.message?.message_thread_id,
        onOpenRouterCharge: (charge) => {
          chargeReports = chargeReports.then(async () => {
            try {
              await ctx.reply(formatOpenRouterChargeLine(charge));
            } catch (err) {
              logger.warn(
                {
                  event: "openrouter_charge_reply_failed",
                  topic: charge.topic,
                  error: String(err),
                },
                "Failed to send OpenRouter charge to Telegram",
              );
            }
          });
          return chargeReports;
        },
      });
      await chargeReports;
      await ctx.reply(formatPipelineReply(result));
    } finally {
      newsRunning = false;
    }
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
      onStart: (info) => {
        logger.info(
          { event: "bot_started", username: info.username },
          "Bot is running; waiting for /news",
        );
      },
    });
  } finally {
    store.close();
    logger.info({ event: "bot_stopped" }, "Bot stopped");
  }
}

await main();
