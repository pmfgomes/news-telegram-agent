# Bot listen

The agent starts long polling and waits for `/news`. Users never hit a URL. They see a bot that is online in the forum group.

## Sub-features

- `listen-start` logs `bot_started` and waits.
- `listen-singleton` refuses a second poller on the same token.

## How to get to it (user POV)

- `docker compose up -d` on a machine with `.env` filled.
- `DATA_PATH=./data bun run src/main.ts`.
- In Telegram, the bot is a member of the configured forum group.

## Driving it with bun helpers

Preconditions:

- `.env` has `TELEGRAM_BOT_TOKEN`.
- No extra poller will be started if one is already running.

- **Identity.** Run `bun .cursor/skills/verify-news-telegram-agent/scripts/doctor.ts`. Exit 0. `doctor.json` contains `username` and `id`.
- **Process.** If this run started compose, `docker compose logs --tail=50` includes `bot_started`. If the user already had it up, doctor plus `docker compose ps` is enough. Do not start another stack to prove listen.
- **Proof.** Keep `doctor.json`. If logs were captured, store a redacted snippet next to it, token-free.

## Gotchas

- `getMe` succeeding does not prove polling is running. It only proves the token works.
- A second `bot.start()` on the same token steals updates. The live bot looks dead.
- Host Bun must set `DATA_PATH`. The default `/app/data` is the container path.
