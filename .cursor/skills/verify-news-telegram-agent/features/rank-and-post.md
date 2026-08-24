# Rank and post

OpenRouter groups coverage and scores it per topic. Items that pass `relevance_threshold` become one self-contained HTML newsletter document sent with `sendDocument`. `ranking_mode: latest` skips the relevance filter for that topic.

## Sub-features

- `rank-openrouter` returns ranked clusters with short factual summaries and a billed cost per OpenRouter call.
- `rank-overlap` starts each topic's OpenRouter call as soon as that topic's mapped sources finish, without waiting for unrelated sources.
- `post-newsletter` builds the Tailwind HTML file, shows the run's total OpenRouter cost after the Newsletter title, and uploads it to the thread where `/news` was invoked.
- `post-mark` writes posted items into SQLite only after a successful document send.

## How to get to it (user POV)

- Send `/news` as a group admin. There is no other user entry.
- Download the `.html` attachment and open it in a browser. Use the topic tabs to switch sections.

## Driving it with bun helpers

Preconditions:

- User asked to post.
- Doctor exits 0.
- One poller is running.
- Every topic in `config.yaml` has `telegram_thread_id` (still required for ranking topic resolution).

- **Drive.** Send `/news`. There is no rank-only helper that still proves the user path.
- **Observe.** `runs.jsonl` has `posted`, `llm_cost`, `llm_charges`, `output: "newsletter_html"`, `per_topic`, or an error. Telegram shows one closing reply with `OpenRouter total` (and `Error in …` if ranking failed for any topic) plus one newsletter document in the invoking thread. The HTML header shows `Cost $…` immediately after `Newsletter`.
- **Offline HTML check.** Renderer tests plus opening a generated fixture prove layout without posting.
- **Concurrency check.** `bun test src/llm/rank.test.ts` holds one topic's source promise open and proves another topic starts processing first.
- **Skipped by fetch-smoke.** Fetch-smoke does not import `rankItems` or `postNewsletter`. Treat rank-and-post as unverified after fetch-smoke.

## Gotchas

- This spends OpenRouter credit and posts into the real group.
- `resolveTopicThreads` runs first. Missing topics fail before RSS.
- `markPosted` runs in the `onPosted` callback after a successful send. A send error must not mark items posted.
- The attachment is a download, not an in-Telegram web view.
