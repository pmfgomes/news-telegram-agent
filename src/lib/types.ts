export type {
  AppConfig,
  EnvSecrets,
  LlmRankRow,
  LlmRankResponse,
  OpenRouterUsage,
  SourceConfig,
  TopicConfig,
} from "./schemas.ts";

export type NewsItem = {
  id: string;
  title: string;
  link: string;
  source: string;
  publishedAt: Date | null;
  summary?: string;
};

export type RankedItem = NewsItem & {
  score: number;
  reason: string;
  topic: string;
  threadId: number;
  relatedItems: NewsItem[];
};
