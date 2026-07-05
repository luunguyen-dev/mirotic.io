/**
 * poller.ts — 1 chu kỳ poll của worker.
 *
 * Thứ tự:
 *   1. Xử lý deploy queue (status=deploy-requested → chạy ship.sh).
 *   2. Seed empty projects (LLM sinh issue backlog cho project mới promoted).
 *   3. Build queue: claim ý tưởng approved trong rolling BUILD_WINDOW_HOURS,
 *      loop đến khi hit DAILY_BUILD_LIMIT hoặc queue trống.
 *
 * Rate-limit-aware:
 *   claimNextApproved() tự skip job có retry_after > now (auto-fallback rate-limit),
 *   nên poller không cần biết logic đó.
 */

import { CONFIG } from "../config";
import * as db from "../db";
import { log } from "../util/logger";
import { deploy } from "../executor/deployer";
import { runBuild } from "../executor/builder";
import { seedEmptyProjects } from "../projects";

export async function pollOnce(): Promise<void> {
  // 1) Deploy requests (không giới hạn theo ngày)
  let d = await db.claimNextDeployRequested();
  while (d) { await deploy(d.id); d = await db.claimNextDeployRequested(); }

  // 2) Seed empty projects (LLM cần Claude auth — chỉ chạy trên worker Mac)
  try { await seedEmptyProjects(); }
  catch (e: any) { log(`(seedEmptyProjects err: ${e?.message ?? e})`); }

  // 3) Build: tối đa DAILY_BUILD_LIMIT ý tưởng trong rolling BUILD_WINDOW_HOURS (default 24h).
  //    Claim tuần tự đến khi hit gate hoặc hết approved queue trong cùng cycle.
  while (true) {
    const inWindow = await db.countStartedRecent(CONFIG.buildWindowHours);
    if (inWindow >= CONFIG.dailyBuildLimit) {
      const oldest = await db.oldestStartedInWindow(CONFIG.buildWindowHours);
      const nextSlot = oldest
        ? new Date(new Date(oldest).getTime() + CONFIG.buildWindowHours * 3600 * 1000).toISOString()
        : "?";
      log(`⏭️  đã thực thi ${inWindow}/${CONFIG.dailyBuildLimit} trong ${CONFIG.buildWindowHours}h qua — slot tiếp theo mở lúc ${nextSlot}`);
      db.appendSystemLog("poller", `Gate ${inWindow}/${CONFIG.dailyBuildLimit} full — next slot ${nextSlot}`, "info").catch(() => {});
      return;
    }
    const job = await db.claimNextApproved();
    if (!job) {
      log("⏳ chưa có ý tưởng status=approved");
      db.appendSystemLog("poller", "No approved jobs to build", "info").catch(() => {});
      return;
    }
    log(`▶️  build ${inWindow + 1}/${CONFIG.dailyBuildLimit} (rolling ${CONFIG.buildWindowHours}h): ${job.id}`);
    db.appendSystemLog("poller", `Claimed ${job.id} for build (slot ${inWindow + 1}/${CONFIG.dailyBuildLimit})`, "summary").catch(() => {});
    await runBuild(job.id);
  }
}
