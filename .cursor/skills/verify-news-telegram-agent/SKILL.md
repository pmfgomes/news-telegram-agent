---
name: verify-news-telegram-agent
description: Drive the news-telegram-agent Bun bot, RSS ingest, SQLite dedupe, and Telegram /news path. Use when proving agent fetch, ranking, posting, docker compose, or any news-telegram-agent behavior.
---

# Verify news-telegram-agent

The user-facing app is a long-polling Telegram bot in a forum group. Admins send `/news`. The process fetches RSS, drops already-posted items, ranks with OpenRouter, and sends one self-contained HTML newsletter document to the invoking thread. There is no hosted web UI.

Read `features/README.md` before driving. Use the matching feature file as the recipe.

Telegram allows one `getUpdates` consumer per token. Two pollers fight. Fetch-smoke does not poll and may run beside a live container. A second `bun run src/main.ts` or a second compose stack must not be started if doctor already sees a live bot.

## Launch

Preferred, from the repo README:

```bash
docker compose build
docker compose up -d
```

Ready when `docker compose logs` contains `event":"bot_started"` or the line `Bot is running; waiting for /news`.

Local Bun alternative:

```bash
bun install
DATA_PATH=./data bun run src/main.ts
```

Ready when stdout contains `bot_started`. `DATA_PATH` must be set on the host. The code defaults to `/app/data`, which is the container path.

Needed in `.env`: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_GROUP_ID`, `OPENROUTER_API_KEY`. Topics and sources come from `src/config/config.yaml`.

Do not launch if a poller for this token is already running. Doctor the existing instance instead.

Teardown: if this run started compose, `docker compose down` with the same project. If this run started Bun, signal that PID with SIGINT. If the user already had the bot up, leave it.

## Doctor

```bash
bun .cursor/skills/verify-news-telegram-agent/scripts/doctor.ts
```

Doctor calls Telegram `getMe` and does not start polling. It writes `doctor.json` to the evidence dir with bot username and id, never the token. Exit 0 only when `getMe` succeeds.

Optional live-poller check: `docker compose ps`. A running `news-agent` container means fetch-smoke is still allowed and a second poller is not.

## Drive

Pick the feature file. Default cheap proof is RSS ingest, not a live `/news`.

```bash
bun .cursor/skills/verify-news-telegram-agent/scripts/fetch-smoke.ts
```

That script loads `src/config/config.yaml`, fetches every source through `fetchAllSources`, and writes `fetch-smoke.json`. It does not call OpenRouter. It does not send Telegram messages. It does not write `data/news.db`. If `DATA_PATH/news.db` or `./data/news.db` exists, it copies the file into evidence and runs `filterNew` on the copy so dedupe numbers are real.

Live `/news` is the real user path. Only drive it when the user asked to post. Then send `/news` as a group admin in `TELEGRAM_GROUP_ID` and watch logs plus `data/logs/runs.jsonl`. Do not script a fake command handler.

## Evidence

`.cursor/skills/verify-news-telegram-agent/evidence/<run-id>/`

Set `VERIFY_EVIDENCE_DIR` before helpers. Keep:

- `doctor.json`
- `fetch-smoke.json`
- copied `news.db` when dedupe ran
- for a live `/news`: the matching `runs.jsonl` line, not the whole history dump if it contains titles you do not need

Proof standards:

- Fetch proof: at least one source returns items, or the JSON lists every source failure. Zero items with zero `fetch_fail` events is a failed proof.
- Dedupe proof: `filterNew` on a copy of the real DB. An empty temp DB that keeps every item does not prove production dedupe.
- `/news` proof: group newsletter document plus `runs.jsonl` `event` of `run_complete` or `run_failed`. A reply of "Getting the news…" is not the end state.
- Fetch-smoke skips OpenRouter and Telegram send. Confirm that by the script never importing `rankItems` or `postNewsletter`. Do not call that a full `/news` proof.

## Cleanup

- Stop only processes or compose stacks this run started.
- Never `docker compose down` a stack this run did not start.
- Do not delete `data/news.db` or `data/logs/runs.jsonl`.
- Do not delete `.cursor/skills/verify-news-telegram-agent/evidence/`.
- Temp DB copies live in the evidence dir and stay there.

## Helpers

`bun .cursor/skills/verify-news-telegram-agent/scripts/doctor.ts`

`bun .cursor/skills/verify-news-telegram-agent/scripts/fetch-smoke.ts`

Run both from the repo root so Bun loads `.env` and `src/` imports resolve.
