# News command

`/news` is the only command. A group admin in `TELEGRAM_GROUP_ID` starts one pipeline run. Other chats are ignored. Non-admins get a refusal. A run already in progress gets `Already getting the news. Please wait.`

## Sub-features

- `news-admin` starts a run and replies `Getting the news…`, then one line per OpenRouter charge (`OpenRouter · <topic> · $<cost>`), then a Done/failed line that lists every charge and `Total: $<sum>`.
- `news-non-admin` replies `Only group admins can run /news.`
- `news-busy` refuses a second overlapping run.
- `news-wrong-chat` ignores DMs and other groups.

## How to get to it (user POV)

- In the configured forum group, as an admin, send `/news`.
- BotFather can keep Group Privacy on. Slash commands still arrive.
- A successful run uploads one HTML newsletter to the same topic/thread where the command was sent.

## Driving it with bun helpers

Preconditions:

- Doctor exits 0.
- A single poller is running.
- The sender is a group admin in `TELEGRAM_GROUP_ID`.
- The user asked to post. This path talks to OpenRouter and Telegram.

- **Send `/news`.** There is no safe helper that fakes this. Send the command in Telegram.
- **Watch the run.** Follow `docker compose logs -f` or Bun stdout until a `run_complete` or `run_failed` log. Read the new line in `data/logs/runs.jsonl`.
- **End state.** The bot replies with each OpenRouter charge as ranking finishes, then `Done — sent newsletter with N stor(y|ies).` (plus an OpenRouter itemized total), `Done — nothing new to post.`, `Done — no items passed the relevance threshold.`, or `News run failed: …`. Each of those closing replies includes the OpenRouter charge list and `Total`.
- **Proof.** That reply plus the newsletter document in the thread plus the `runs.jsonl` line (`output: "newsletter_html"` when posted). "Getting the news…" alone is not proof.

## Gotchas

- This posts into the real group and can mark SQLite rows posted. Do not use it as the default verification drive.
- Overlapping `/news` is in-process memory. Two containers would both accept `/news`.
- Missing `telegram_thread_id` fails the run with `Topic is missing: <name>`.
