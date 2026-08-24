import { Bot, GrammyError, HttpError, InputFile } from "grammy";
import { formatUsd } from "../lib/money.ts";
import { logger } from "../lib/logger.ts";
import type { RankedItem, TopicConfig } from "../lib/types.ts";
import {
  newsletterFilename,
  renderNewsletterHtml,
} from "../newsletter/index.ts";
import type { Store } from "../store/index.ts";

export function createBot(token: string): Bot {
  return new Bot(token);
}

/**
 * Structured log fields for a failed Telegram call: surfaces the Bot API
 * error code, method, and parameters (e.g. retry_after on 429) that
 * String(err) hides.
 */
export function telegramErrorFields(err: unknown): Record<string, unknown> {
  if (err instanceof GrammyError) {
    return {
      error: err.description,
      error_code: err.error_code,
      method: err.method,
      parameters: err.parameters,
    };
  }
  if (err instanceof HttpError) {
    return { error: String(err), kind: "network" };
  }
  return {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  };
}

export function missingTopicError(topicName: string): Error {
  return new Error(`Topic is missing: ${topicName}`);
}

/**
 * Resolve topic name → message_thread_id from config or SQLite.
 * Topics are assumed to already exist in Telegram; this never creates them.
 */
export function resolveTopicThreads(
  groupId: string,
  topics: TopicConfig[],
  store: Store,
): Map<string, number> {
  const map = new Map<string, number>();

  for (const topic of topics) {
    const threadId =
      topic.telegram_thread_id ?? store.getTopicThreadId(groupId, topic.name);

    if (threadId === null || threadId === undefined) {
      throw missingTopicError(topic.name);
    }

    store.upsertTopic(groupId, topic, threadId);
    map.set(topic.name, threadId);
    logger.info(
      {
        event: "topic_thread_resolved",
        topic: topic.name,
        threadId,
        source: topic.telegram_thread_id !== undefined ? "config" : "db",
      },
      "Resolved Telegram topic thread id",
    );
  }

  return map;
}

/** @deprecated Use resolveTopicThreads */
export const ensureForumTopics = resolveTopicThreads;

function isMissingTopicSendError(err: unknown): boolean {
  const description =
    err instanceof GrammyError
      ? err.description
      : err instanceof Error
        ? err.message
        : String(err);
  const text = description.toLowerCase();
  return (
    text.includes("message thread not found") ||
    text.includes("topic_id_invalid") ||
    text.includes("thread not found") ||
    (text.includes("message_thread_id") && text.includes("invalid"))
  );
}

export async function postNewsletter(
  bot: Bot,
  groupId: string,
  opts: {
    topics: string[];
    items: RankedItem[];
    messageThreadId?: number;
    generatedAt?: Date;
    cost?: number;
    onPosted?: (items: RankedItem[]) => void;
  },
): Promise<number> {
  const generatedAt = opts.generatedAt ?? new Date();
  const filename = newsletterFilename(generatedAt);
  const cost = opts.cost ?? 0;
  const html = renderNewsletterHtml({
    topics: opts.topics,
    items: opts.items,
    generatedAt,
    title: "News newsletter",
    cost,
  });
  const caption = `News newsletter — ${opts.items.length} stor${
    opts.items.length === 1 ? "y" : "ies"
  } across ${opts.topics.length} topic${opts.topics.length === 1 ? "" : "s"}. Cost ${formatUsd(cost)}.`;
  const bytes = Buffer.byteLength(html, "utf8");

  logger.info(
    {
      event: "telegram_newsletter_send",
      chat: groupId,
      threadId: opts.messageThreadId,
      itemCount: opts.items.length,
      filename,
      bytes,
    },
    "Sending newsletter HTML document to Telegram",
  );

  try {
    await bot.api.sendDocument(
      groupId,
      new InputFile(Buffer.from(html, "utf8"), filename),
      {
        caption,
        ...(opts.messageThreadId !== undefined
          ? { message_thread_id: opts.messageThreadId }
          : {}),
      },
    );
  } catch (err) {
    logger.error(
      {
        event: "telegram_fail",
        chat: groupId,
        threadId: opts.messageThreadId,
        ids: opts.items.map((item) => item.id),
        filename,
        bytes,
        ...telegramErrorFields(err),
      },
      "Failed to post newsletter to Telegram",
    );
    if (isMissingTopicSendError(err)) {
      throw new Error(
        opts.messageThreadId !== undefined
          ? `Topic thread ${opts.messageThreadId} is missing or invalid`
          : "Failed to post newsletter: invalid thread",
      );
    }
    throw err;
  }

  opts.onPosted?.(opts.items);
  logger.info(
    {
      event: "telegram_newsletter_post",
      chat: groupId,
      threadId: opts.messageThreadId,
      ids: opts.items.map((item) => item.id),
      itemCount: opts.items.length,
      filename,
    },
    "Posted newsletter HTML document to Telegram",
  );

  return opts.items.length;
}

export async function sendFailureAlert(
  bot: Bot,
  chatId: string,
  message: string,
): Promise<void> {
  try {
    await bot.api.sendMessage(chatId, `news-telegram-agent failure:\n${message}`);
    logger.info({ event: "telegram_alert", chat: chatId }, "Sent failure alert");
  } catch (err) {
    logger.error(
      { event: "telegram_alert_fail", chat: chatId, ...telegramErrorFields(err) },
      "Failed to send failure alert",
    );
  }
}
