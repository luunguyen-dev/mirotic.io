/**
 * index.ts — Entry point. Mode dispatch cho các command.
 *
 * Modes:
 *   bun run src/index.ts daemon    # server + morning batch + poller interval (default, Docker)
 *   bun run src/index.ts serve     # chỉ dashboard :4321
 *   bun run src/index.ts worker    # Mac worker: batch + poller, không serve
 *   bun run src/index.ts poll      # chạy 1 chu kỳ poller rồi thoát
 *   bun run src/index.ts generate  # sinh 1 idea (single) rồi thoát
 *   bun run src/index.ts batch     # sinh 1 batch (10 candidates + CEO) rồi thoát
 *   bun run src/index.ts demo      # full flow trong bộ nhớ (mock, ~6s)
 */

import { mkdirSync } from "node:fs";
import { CONFIG } from "./config";
import * as db from "./db";
import { log } from "./util/logger";
import { startServer } from "./api/server";
import { pollOnce } from "./worker/poller";
import { runDaemon, runWorker, generateIdea, generateIdeaBatch } from "./worker/daemon";
import { runBuild } from "./executor/builder";
import { deploy } from "./executor/deployer";

// Bootstrap: đảm bảo dirs tồn tại trước khi mọi module ghi vào.
mkdirSync(CONFIG.outbox, { recursive: true });
mkdirSync(CONFIG.builds, { recursive: true });

async function main() {
  const mode = process.argv[2] ?? "daemon";
  if (mode === "daemon") return runDaemon();
  if (mode === "serve") { await db.initDb(); return startServer(); }
  if (mode === "worker") return runWorker();
  if (mode === "poll") { await db.initDb(); await pollOnce(); return db.closeDb(); }
  if (mode === "generate") { await db.initDb(); await generateIdea(); return db.closeDb(); }
  if (mode === "batch") { await db.initDb(); await generateIdeaBatch(); return db.closeDb(); }

  // demo: full flow trong bộ nhớ (bỏ qua chờ poller & gate 1/ngày để xem trọn luồng)
  log("══════════ DEMO: trọn luồng (mock) ══════════");
  await db.initDb();
  const id = await generateIdea();
  log("\n👆 (giả lập: duyệt trên web → approved)");
  await db.setStatus(id, "approved");
  const j = await db.claimNextApproved();
  if (j) await runBuild(j.id);
  log("\n👆 (giả lập: bấm Deploy trên web → deploy-requested)");
  await db.setStatus(id, "deploy-requested");
  const dr = await db.claimNextDeployRequested();
  if (dr) await deploy(dr.id);
  const final = await db.getJob(id);
  log(`\n══════════ Xong. status=${final?.status} · repo ${final?.result?.repoUrl} · live ${final?.result?.deployedUrl} ══════════`);
  await db.closeDb();
}

main();
