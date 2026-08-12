# news-telegram-agent

One-shot Bun pipeline: fetch RSS (scrape fallback) → dedupe → cluster and rank coverage by topic with OpenRouter → post into matching Telegram **group** topics.

Runs as a portable Docker container. Schedule it with cron, QNAP Task Scheduler, or any job runner.

## Layout

```
src/
  main.ts           # one-shot pipeline entrypoint
  config/           # config.yaml + env/YAML loading
  fetch/            # RSS + scrape fallback
  store/            # SQLite dedupe + topic thread cache
  llm/              # OpenRouter rank + billed usage/cost
  telegram/         # topic resolution, posts, failure alerts
  lib/              # shared logger, Zod schemas, types
```

## Quick start

1. Copy env and fill secrets:

```bash
cp .env.example .env
```

2. Edit topics and sources in [`src/config/config.yaml`](src/config/config.yaml). Topic `name` must match your Telegram topic names exactly. Each source lists the topics it supplies; the agent fetches its 10 newest articles.

3. Build and run once:

```bash
docker compose build
docker compose run --rm news-agent
```

Logs (requests, failures, LLM tokens + OpenRouter billed `cost`) go to container stdout as JSON (pino).

## Environment

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | BotFather token |
| `TELEGRAM_GROUP_ID` | yes | Forum group `@username` or numeric id (usually `-100...`) |
| `OPENROUTER_API_KEY` | yes | OpenRouter API key |
| `OPENROUTER_MODEL` | no | Default `google/gemini-2.5-flash-lite` |
| `DATA_DIR` | no | Host path mounted to `/app/data` (default `./data`) |
| `CONFIG_FILE` | no | Host path mounted over `/app/src/config/config.yaml` (default `./src/config/config.yaml`) |
| `TELEGRAM_ALERT_CHAT_ID` | no | Personal chat id for failure alerts |
| `LOG_LEVEL` | no | Default `info` |

`TELEGRAM_CHAT_ID` / `TELEGRAM_CHANNEL_ID` are accepted as aliases for `TELEGRAM_GROUP_ID`.

Inside the container, SQLite and logs always live under `/app/data`. Change only the host side with `DATA_DIR`.

## Local Bun (optional)

```bash
bun install
DATA_PATH=./data bun run src/main.ts
```

## Scheduling examples

**cron / Linux:**

```bash
0 8,13,19 * * * cd /path/to/news-telegram-agent && docker compose run --rm news-agent
```

**QNAP Task Scheduler:** user-defined script, e.g. 08:00 / 13:00 / 19:00:

```bash
cd /share/Container/news-agent && docker compose run --rm news-agent
```

Set `DATA_DIR` in `.env` to a persistent NAS folder so dedupe survives across runs.

## Telegram setup (forum group topics)

This project targets a **forum-enabled group** (Topics on), not a broadcast channel.

1. Create a bot with [@BotFather](https://t.me/BotFather)
2. Create a **group**, enable **Topics**, and allow the bot to post messages
3. Put the bot token and group id in `.env` as `TELEGRAM_GROUP_ID` (public `@name` or numeric `-100...`)
4. Create the topics yourself and set each topic's `telegram_thread_id` in `src/config/config.yaml`

Telegram Bot API cannot list existing topics by name, so the agent does not create or discover topics. A missing or invalid thread id stops the run with the missing topic name.

```yaml
topics:
  - name: Technology
    interest: Consumer tech, gadgets, software
    telegram_thread_id: 123

sources:
  - name: BBC Technology
    topics: [Technology]
    rss_url: https://feeds.bbci.co.uk/news/technology/rss.xml
```

Keep `DATA_DIR` persistent so topic ids survive container restarts.

Each source contributes up to `latest_per_source` newest articles (10 by default). The model groups coverage of the same event and selects up to `top_n` story clusters **per topic**.

### Config YAML vs SQLite

- **YAML** stays the editable source of truth for topics/sources (tiny; not a performance bottleneck).
- **SQLite** stores posted-item dedupe and the Telegram topic registry (`topic_name` → `thread_id`) for fast, durable lookups across runs.
