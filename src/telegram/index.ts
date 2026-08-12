import { Bot, GrammyError } from "grammy";
import { logger } from "../lib/logger.ts";
import type { RankedItem, TopicConfig } from "../lib/types.ts";
import type { Store } from "../store/index.ts";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function formatMessage(item: RankedItem, index?: number): string {
  const title = escapeHtml(item.title);
  const source = escapeHtml(item.source);
  const reason = escapeHtml(item.reason);
  const prefix = index === undefined ? "" : `${index}. `;

  const lines = [
    `<b>${prefix}${title}</b>`,
    `<a href="${escapeHtml(item.link)}">${source}</a>`,
  ];

  if (item.relatedItems.length > 0) {
    lines.push(
      `<b>More coverage:</b> ${item.relatedItems
        .map(
          (related) =>
            `<a href="${escapeHtml(related.link)}">${escapeHtml(related.source)}</a>`,
        )
        .join(" · ")}`,
    );
  }

  lines.push(`<i>${reason}</i>`);
  return lines.join("\n");
}

export function formatTopicMessage(items: RankedItem[]): string {
  const topic = escapeHtml(items[0]?.topic ?? "");
  const news = items.map((item, index) => formatMessage(item, index + 1));
  return [`<b>${topic}</b>`, ...news].join("\n\n");
}

export function createBot(token: string): Bot {
  return new Bot(token);
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

const TOPIC_SEND_DELAY_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Group items by topic, preserving first-seen topic order. */
function groupByTopic(items: RankedItem[]): RankedItem[][] {
  const order: string[] = [];
  const groups = new Map<string, RankedItem[]>();

  for (const item of items) {
    if (!groups.has(item.topic)) {
      order.push(item.topic);
      groups.set(item.topic, []);
    }
    groups.get(item.topic)!.push(item);
  }

  return order.map((topic) => groups.get(topic)!);
}

export async function postItems(
  bot: Bot,
  groupId: string,
  items: RankedItem[],
  onPosted?: (group: RankedItem[]) => void,
): Promise<number> {
  let posted = 0;
  const topicGroups = groupByTopic(items);

  for (let i = 0; i < topicGroups.length; i++) {
    if (i > 0) {
      await sleep(TOPIC_SEND_DELAY_MS);
    }

    const group = topicGroups[i]!;
    logger.info(
      {
        event: "telegram_topic_batch",
        chat: groupId,
        topic: group[0]?.topic,
        count: group.length,
        delay_ms: i > 0 ? TOPIC_SEND_DELAY_MS : 0,
      },
      "Sending topic batch to Telegram",
    );

    const first = group[0]!;
    try {
      await bot.api.sendMessage(groupId, formatTopicMessage(group), {
        parse_mode: "HTML",
        message_thread_id: first.threadId,
        link_preview_options: { is_disabled: true },
      });
      posted += group.length;
      onPosted?.(group);
      logger.info(
        {
          event: "telegram_topic_post",
          ids: group.map((item) => item.id),
          chat: groupId,
          topic: first.topic,
          threadId: first.threadId,
          itemCount: group.length,
        },
        "Posted news batch to Telegram topic",
      );
    } catch (err) {
      logger.error(
        {
          event: "telegram_fail",
          ids: group.map((item) => item.id),
          chat: groupId,
          topic: first.topic,
          threadId: first.threadId,
          error: String(err),
        },
        "Failed to post news batch to Telegram",
      );
      if (isMissingTopicSendError(err)) {
        throw missingTopicError(first.topic);
      }
      throw err;
    }
  }
  return posted;
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
      { event: "telegram_alert_fail", chat: chatId, error: String(err) },
      "Failed to send failure alert",
    );
  }
}
