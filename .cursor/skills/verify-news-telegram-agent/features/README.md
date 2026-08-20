# News telegram agent verification map

This directory is the maintained source for verifying the bot's user-facing behavior. Read this index before driving, then use the matching feature file as the recipe.

## Baseline preconditions

- Run helpers from the repo root.
- Doctor with `bun .cursor/skills/verify-news-telegram-agent/scripts/doctor.ts` before any live Telegram drive.
- Fetch-smoke may run without a live poller.
- Never start a second long-polling process for the same bot token.
- Never send `/news` unless the user asked to post into the real group.

## Driving conventions

- Start from the feature file's preconditions.
- Treat commands as literal.
- Prefer helper scripts over ad-hoc `curl` to Telegram.
- Do not mark items posted from a verification script.

## Proof and skip reporting

- Capture the action and the resulting state.
- Fetch proof is `fetch-smoke.json`.
- Live `/news` proof is the newsletter document plus a `runs.jsonl` line.
- Record the feature ID with every artifact.
- Report unreachable paths with the unmet precondition.

## Features

- [Bot listen](./bot-listen.md) covers long polling coming up and staying up.
- [News command](./news-command.md) covers `/news` from a group admin.
- [RSS ingest](./rss-ingest.md) covers fetch and scrape fallback.
- [Dedupe](./dedupe.md) covers SQLite posted-item filtering.
- [Rank and post](./rank-and-post.md) covers OpenRouter ranking and the HTML newsletter document.
