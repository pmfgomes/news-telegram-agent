import { readFileSync } from "node:fs";
import { join } from "node:path";
import { YAML } from "bun";
import { ZodError } from "zod";
import { logger } from "../lib/logger.ts";
import {
  appConfigSchema,
  envSecretsSchema,
  formatZodError,
  type AppConfig,
  type EnvSecrets,
} from "../lib/schemas.ts";

const DEFAULT_CONFIG_PATH = join(import.meta.dir, "config.yaml");

export type { EnvSecrets };

export function loadSecrets(): EnvSecrets {
  try {
    return envSecretsSchema.parse({
      telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
      // Prefer group id; keep older env names as aliases.
      telegramGroupId:
        process.env.TELEGRAM_GROUP_ID?.trim() ||
        process.env.TELEGRAM_CHAT_ID?.trim() ||
        process.env.TELEGRAM_CHANNEL_ID?.trim(),
      openRouterApiKey: process.env.OPENROUTER_API_KEY,
      openRouterModel: process.env.OPENROUTER_MODEL?.trim() || undefined,
      telegramAlertChatId: process.env.TELEGRAM_ALERT_CHAT_ID?.trim() || undefined,
    });
  } catch (err) {
    if (err instanceof ZodError) {
      throw new Error(`Invalid environment: ${formatZodError(err)}`);
    }
    throw err;
  }
}

export function loadConfig(path = process.env.CONFIG_PATH ?? DEFAULT_CONFIG_PATH): AppConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Failed to read config at ${path}: ${String(err)}`);
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse YAML at ${path}: ${String(err)}`);
  }

  // Multi-doc YAML returns an array; use the first document.
  if (Array.isArray(parsed)) {
    parsed = parsed[0];
  }

  let config: AppConfig;
  try {
    config = appConfigSchema.parse(parsed);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new Error(`Invalid config at ${path}:\n${formatZodError(err)}`);
    }
    throw err;
  }

  logger.info(
    {
      event: "config_loaded",
      path,
      topicCount: config.topics.length,
      topics: config.topics.map((t) => t.name),
      sourceCount: config.sources.length,
      timezone: config.timezone,
    },
    "Loaded config",
  );

  return config;
}

export function dataDir(): string {
  return process.env.DATA_PATH ?? "/app/data";
}
