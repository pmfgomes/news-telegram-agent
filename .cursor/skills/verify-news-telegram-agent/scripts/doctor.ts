#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSecrets } from "../../../../src/config/index.ts";
import { createBot } from "../../../../src/telegram/index.ts";

const evidenceDir =
  process.env.VERIFY_EVIDENCE_DIR ??
  join(import.meta.dir, "..", "evidence", new Date().toISOString().replaceAll(":", "-"));
mkdirSync(evidenceDir, { recursive: true });

const secrets = loadSecrets();
const bot = createBot(secrets.telegramBotToken);
const me = await bot.api.getMe();

const report = {
  at: new Date().toISOString(),
  ok: true,
  id: me.id,
  username: me.username,
  canJoinGroups: me.can_join_groups,
  canReadAllGroupMessages: me.can_read_all_group_messages,
  pollingStarted: false,
  evidenceDir,
};

writeFileSync(join(evidenceDir, "doctor.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, username: me.username, id: me.id, evidenceDir }, null, 2));
