#!/usr/bin/env bun
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../../../src/config/index.ts";
import { fetchAllSources } from "../../../../src/fetch/index.ts";
import { Store } from "../../../../src/store/index.ts";

const evidenceDir =
  process.env.VERIFY_EVIDENCE_DIR ??
  join(import.meta.dir, "..", "evidence", new Date().toISOString().replaceAll(":", "-"));
mkdirSync(evidenceDir, { recursive: true });

const config = loadConfig();
const items = await fetchAllSources(config);

const perSource: Record<string, number> = {};
for (const source of config.sources) perSource[source.name] = 0;
for (const item of items) {
  perSource[item.source] = (perSource[item.source] ?? 0) + 1;
}

const liveDbCandidates = [
  process.env.DATA_PATH ? join(process.env.DATA_PATH, "news.db") : null,
  join(process.cwd(), "data", "news.db"),
].filter((path): path is string => Boolean(path));

const liveDbPath = liveDbCandidates.find((path) => existsSync(path)) ?? null;
let freshCount: number | null = null;
let dbCopyPath: string | null = null;

if (liveDbPath) {
  dbCopyPath = join(evidenceDir, "news.copy.db");
  copyFileSync(liveDbPath, dbCopyPath);
  process.env.DATA_PATH = evidenceDir;
  const store = new Store(dbCopyPath);
  try {
    freshCount = store.filterNew(items).length;
  } finally {
    store.close();
  }
}

const failures = config.sources
  .filter((source) => (perSource[source.name] ?? 0) === 0)
  .map((source) => source.name);

const report = {
  at: new Date().toISOString(),
  sourceCount: config.sources.length,
  fetchedCount: items.length,
  perSource,
  zeroItemSources: failures,
  liveDbPath,
  dbCopyPath,
  freshCount,
  alreadyPostedCount: freshCount === null ? null : items.length - freshCount,
  posted: false,
  ranked: false,
  evidenceDir,
};

writeFileSync(join(evidenceDir, "fetch-smoke.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      ok: items.length > 0,
      evidenceDir,
      fetchedCount: items.length,
      freshCount,
      alreadyPostedCount: report.alreadyPostedCount,
      zeroItemSources: failures,
    },
    null,
    2,
  ),
);

if (items.length === 0) {
  process.exit(1);
}
