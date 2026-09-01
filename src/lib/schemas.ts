import { z } from "zod";

export const sourceConfigSchema = z
  .object({
    name: z.string().trim().min(1),
    topics: z.array(z.string().trim().min(1)).min(1),
    rss_url: z.string().trim().url().optional(),
    url: z.string().trim().url().optional(),
    scrape_selector: z.string().trim().min(1).optional(),
  })
  .refine((s) => Boolean(s.rss_url) || Boolean(s.url && s.scrape_selector), {
    error: "Source needs rss_url or url+scrape_selector",
  });

const topicObjectSchema = z.object({
  name: z.string().trim().min(1),
  interest: z.string().trim().min(1).optional(),
  /** filter = score by interest; latest = accept all mapped items, only cluster duplicates. */
  ranking_mode: z.enum(["filter", "latest"]).default("filter"),
  telegram_thread_id: z.coerce.number().int().positive().optional(),
});

/** Accept object topics, "Name: interest" strings, or YAML single-key maps. */
export const topicConfigSchema = z
  .preprocess((raw) => {
    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (!trimmed) return raw;
      const split = trimmed.indexOf(":");
      if (split === -1) return { name: trimmed, interest: trimmed };
      return {
        name: trimmed.slice(0, split).trim(),
        interest: trimmed.slice(split + 1).trim() || trimmed,
      };
    }

    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const obj = raw as Record<string, unknown>;
      if (typeof obj.name === "string") return obj;

      const entries = Object.entries(obj);
      if (entries.length === 1) {
        const [key, value] = entries[0]!;
        return { name: key.trim(), interest: String(value).trim() || key.trim() };
      }
    }

    return raw;
  }, topicObjectSchema)
  .transform((topic) => ({
    name: topic.name,
    interest: topic.interest?.trim() || topic.name,
    ranking_mode: topic.ranking_mode,
    ...(topic.telegram_thread_id !== undefined
      ? { telegram_thread_id: topic.telegram_thread_id }
      : {}),
  }));

export const appConfigSchema = z
  .object({
    timezone: z.string().trim().min(1).default("Europe/Lisbon"),
    latest_per_source: z.coerce.number().int().positive().default(10),
    max_candidates: z.coerce.number().int().positive().default(80),
    top_n: z.coerce.number().int().positive().default(10),
    relevance_threshold: z.coerce.number().min(0).max(1).default(0.6),
    topics: z.array(topicConfigSchema).min(1),
    sources: z.array(sourceConfigSchema).min(1),
  })
  .superRefine((config, ctx) => {
    const seen = new Set<string>();
    for (const [index, topic] of config.topics.entries()) {
      const key = topic.name.toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate topic name: "${topic.name}"`,
          path: ["topics", index, "name"],
        });
      }
      seen.add(key);
    }

    const sourceNames = new Set<string>();
    for (const [sourceIndex, source] of config.sources.entries()) {
      const sourceKey = source.name.toLowerCase();
      if (sourceNames.has(sourceKey)) {
        ctx.addIssue({
          code: "custom",
          message: `Duplicate source name: "${source.name}"`,
          path: ["sources", sourceIndex, "name"],
        });
      }
      sourceNames.add(sourceKey);

      for (const [topicIndex, topicName] of source.topics.entries()) {
        if (!seen.has(topicName.toLowerCase())) {
          ctx.addIssue({
            code: "custom",
            message: `Source "${source.name}" references unknown topic "${topicName}"`,
            path: ["sources", sourceIndex, "topics", topicIndex],
          });
        }
      }
    }
  });

export const envSecretsSchema = z.object({
  telegramBotToken: z.string().trim().min(1),
  telegramGroupId: z.string().trim().min(1),
  openRouterApiKey: z.string().trim().min(1),
  openRouterModel: z.string().trim().min(1).default("google/gemini-2.5-flash-lite"),
  telegramAlertChatId: z.string().trim().min(1).optional(),
});

export const llmRankRowSchema = z.object({
  id: z.string().min(1),
  related_ids: z.array(z.string().min(1)).default([]),
  topic: z.string().min(1),
  score: z.coerce.number(),
  summary: z.string().optional().default(""),
});

export const llmRankResponseSchema = z.object({
  rankings: z.array(llmRankRowSchema).default([]),
});

export const openRouterUsageSchema = z
  .object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
    cost: z.number().optional(),
    cost_details: z
      .object({
        upstream_inference_cost: z.number().optional(),
      })
      .optional(),
  })
  .passthrough();

export type SourceConfig = z.infer<typeof sourceConfigSchema>;
export type TopicConfig = z.infer<typeof topicConfigSchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;
export type EnvSecrets = z.infer<typeof envSecretsSchema>;
export type LlmRankRow = z.infer<typeof llmRankRowSchema>;
export type LlmRankResponse = z.infer<typeof llmRankResponseSchema>;
export type OpenRouterUsage = z.infer<typeof openRouterUsageSchema>;

export function formatZodError(err: z.ZodError): string {
  return z.prettifyError(err);
}
