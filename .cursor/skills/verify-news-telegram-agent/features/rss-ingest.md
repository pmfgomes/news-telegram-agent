# RSS ingest

Ingest pulls each source's newest articles. RSS is first. If RSS fails and the source has `url` plus `scrape_selector`, it scrapes. One dead source must not kill the rest.

## Sub-features

- `ingest-rss` parses RSS/Atom and keeps title+link items.
- `ingest-latest` keeps `latest_per_source` newest items per source, 10 by default.
- `ingest-continue` logs `fetch_fail` and continues on a bad source.

## How to get to it (user POV)

- Users never call ingest directly. It runs inside `/news`.
- Verification drives it with fetch-smoke so a proof does not post.

## Driving it with bun helpers

Preconditions:

- Network access to the URLs in `src/config/config.yaml`.
- No Telegram token required.

- **Fetch.** Run `bun .cursor/skills/verify-news-telegram-agent/scripts/fetch-smoke.ts`.
- **Observe.** `fetch-smoke.json` lists `itemCount`, `perSource`, and `failures`.
- **Pass bar.** `itemCount > 0`. If a source failed, it appears in `failures` and other sources still contributed.
- **Proof.** The JSON file in `VERIFY_EVIDENCE_DIR`. Sample titles may be stored. Do not paste a huge dump into chat.

## Gotchas

- Fetch-smoke hits the live internet. It is not a mock. It also does not post.
- Público's direct `/rss` 403es. The config uses the Feedburner URL on purpose.
- A source with zero items is a failure for that source, not a global pass, unless others still returned items.
- Do not treat fetch-smoke as `/news`. Ranking and Telegram send are skipped. Confirm by the script importing `fetchAllSources` only.
