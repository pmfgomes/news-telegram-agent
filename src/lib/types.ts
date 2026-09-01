export type {
  AppConfig,
  EnvSecrets,
  LlmRankRow,
  LlmRankResponse,
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
  /** Short factual blurb for the newsletter (LLM or RSS fallback). */
  summary: string;
  topic: string;
  threadId: number;
  relatedItems: NewsItem[];
};
