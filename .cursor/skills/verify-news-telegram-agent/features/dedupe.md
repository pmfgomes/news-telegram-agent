# Dedupe

SQLite `data/news.db` table `posted_items` remembers guid, canonical URL, and title+link hash. A second `/news` must not post the same story again.

## Sub-features

- `dedupe-filter` drops items `Store.isPosted` already knows.
- `dedupe-empty` with a brand-new DB keeps every fetched item.

## How to get to it (user POV)

- Users see this as "nothing new to post" after a recent `/news`.

## Driving it with bun helpers

Preconditions:

- Fetch-smoke can run.
- For production-dedupe proof, `./data/news.db` or `$DATA_PATH/news.db` exists.

- **Copy, don't write.** `fetch-smoke.ts` copies the real DB into the evidence dir and calls `filterNew` on the copy. It never `markPosted`.
- **Observe.** `fetch-smoke.json` fields `fetchedCount`, `freshCount`, `alreadyPostedCount`.
- **Pass bar.** `alreadyPostedCount + freshCount === fetchedCount`. If the live DB has history, `alreadyPostedCount` should be > 0 after a real bot has posted. If the DB is new, `alreadyPostedCount` is 0 and this only proves the empty-store path.
- **Proof.** Evidence copy of `news.db` plus those counts. Do not query the live DB from a second writer.

## Gotchas

- Opening the live `news.db` while the container holds it can lock. Always copy first.
- An empty temp DB that keeps all items does not prove production dedupe. Say which DB was copied.
- Canonicalization strips `utm_*` and a few tracker params. A "new" URL that only differs by those params should be treated as posted.
