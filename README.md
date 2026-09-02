# news-telegram-agent

Always-on Bun Telegram bot: waits for `/news` from a group admin, then fetch RSS (scrape fallback) → dedupe → cluster and rank coverage by topic with OpenRouter → send one self-contained **HTML newsletter** document into the Telegram thread where `/news` was run.

Runs as a portable Docker container that stays up and listens via long polling.

## Layout

```
src/
  main.ts           # long-running bot + /news command
  pipeline.ts       # fetch → dedupe → rank → newsletter (triggered by /news)
  config/           # config.yaml + env/YAML loading
  fetch/            # RSS + scrape fallback
  store/            # SQLite dedupe + topic thread cache
  llm/              # OpenRouter rank + billed usage/cost
  newsletter/       # Tailwind HTML newsletter renderer
  telegram/         # topic resolution, document send, failure alerts
  lib/              # shared logger, Zod schemas, types
```

## Quick start

1. Copy env and fill secrets:

```bash
cp .env.example .env
```

2. Edit topics and sources in [`src/config/config.yaml`](src/config/config.yaml). Topic `name` must match your Telegram topic names exactly. Each source lists the topics it supplies; the agent fetches its `latest_per_source` newest articles (25 in the shipped config).

3. Build and start (stays running):

```bash
docker compose build
docker compose up -d
```

Logs (requests, failures, LLM tokens + OpenRouter billed `cost`) go to container stdout as JSON (pino). Follow with `docker compose logs -f`.

When an LLM ranking response fails to parse, the collected TanStack stream transcript is saved to `data/logs/llm-failures/` (one JSON file per failure) and the `llm_json_parse_failed` log line carries `stage` (where parsing rejected it), `finish_reason`, `run_id`, head/tail previews, and `dump_path` pointing at that file. The `/news` closing reply reports the OpenRouter total and, if ranking failed for some topics, `Error in …` so you can look those topics up in the logs. The HTML newsletter still shows the total after the title.

## Commands

| Command | Who                                                                    | Effect                                                    |
| ------- | ---------------------------------------------------------------------- | --------------------------------------------------------- |
| `/news` | Group admins only (`creator` / `administrator`) in `TELEGRAM_GROUP_ID` | Starts a news run and sends an HTML newsletter attachment |

- If a run is already in progress, the bot replies that it is already getting the news and does not start another.
- Other chats (DMs, other groups) are ignored.
- BotFather **Group Privacy** can stay on (default); Telegram still delivers slash commands to the bot.
- After editing `config.yaml`, restart the container so the new config is loaded.
- The newsletter is a downloadable `.html` file with topic tabs. Open it in a browser; Telegram does not render the page inline.
- After changing newsletter Tailwind classes, run `bun run build:newsletter-css` and commit `src/newsletter/styles.css` (the production image does not run Tailwind).

## Environment

| Variable                 | Required | Description                                                                               |
| ------------------------ | -------- | ----------------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`     | yes      | BotFather token                                                                           |
| `TELEGRAM_GROUP_ID`      | yes      | Forum group `@username` or numeric id (usually `-100...`)                                 |
| `OPENROUTER_API_KEY`     | yes      | OpenRouter API key                                                                        |
| `OPENROUTER_MODEL`       | no       | Default `google/gemini-2.5-flash-lite`                                                    |
| `DATA_DIR`               | no       | Host path mounted to `/app/data` (default `./data`)                                       |
| `CONFIG_FILE`            | no       | Host path mounted over `/app/src/config/config.yaml` (default `./src/config/config.yaml`) |
| `TELEGRAM_ALERT_CHAT_ID` | no       | Personal chat id for failure alerts                                                       |
| `LOG_LEVEL`              | no       | Default `info`                                                                            |

`TELEGRAM_CHAT_ID` / `TELEGRAM_CHANNEL_ID` are accepted as aliases for `TELEGRAM_GROUP_ID`.

Inside the container, SQLite and logs always live under `/app/data`. Change only the host side with `DATA_DIR`.

## Local Bun (optional)

```bash
bun install
DATA_PATH=./data bun run src/main.ts
```

The process stays running and waits for `/news`.

## Telegram setup (forum group topics)

This project targets a **forum-enabled group** (Topics on), not a broadcast channel.

1. Create a bot with [@BotFather](https://t.me/BotFather)
2. Create a **group**, enable **Topics**, and allow the bot to post messages
3. Put the bot token and group id in `.env` as `TELEGRAM_GROUP_ID` (public `@name` or numeric `-100...`)
4. Create the topics yourself and set each topic's `telegram_thread_id` in `src/config/config.yaml`
5. Start the bot (`docker compose up -d`) and run `/news` as a group admin

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

Keep `DATA_DIR` persistent so topic ids and posted-item dedupe survive container restarts.

Each source contributes up to `latest_per_source` newest articles (schema default 10; the shipped config uses 25 so that back-to-back runs still have fresh stories after dedupe). The model groups coverage of the same event and selects up to `top_n` story clusters **per topic**.

Source fetches run concurrently with a 250 ms start stagger. A topic begins its
OpenRouter grouping and ranking as soon as all sources mapped to that topic
finish; it does not wait for unrelated topic sources. All topic ranking calls
can therefore overlap while slower feeds are still downloading.

### Config YAML vs SQLite

- **YAML** stays the editable source of truth for topics/sources (tiny; not a performance bottleneck).
- **SQLite** stores posted-item dedupe and the Telegram topic registry (`topic_name` → `thread_id`) for fast, durable lookups across runs.
