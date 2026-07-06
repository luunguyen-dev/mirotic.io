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
import { ceoReview } from "../executor/ceo";
// CONFIG đã import ở line 15 — chỉ cần dùng.

// Scan job proposed thiếu ceo_rating → thử review lại. Tối đa 5 job/cycle để tránh burn cost khi
// LLM đang cool. LLM tự fallback qua registry — nếu vẫn fail, cycle sau retry.
async function backfillCeoReviews(): Promise<void> {
  const jobs = await db.listJobs(200);
  const missing: string[] = [];
  for (const meta of jobs) {
    const full = await db.getJob(meta.id);
    if (!full || full.status !== "proposed") continue;
    if (full.ceo_rating != null) continue;
    missing.push(full.id);
    if (missing.length >= 5) break;
  }
  if (!missing.length) return;
  log(`🏛  Backfill CEO review cho ${missing.length} job proposed thiếu critique`);
  db.appendSystemLog("ceo", `Backfill start: ${missing.length} jobs`, "summary").catch(() => {});
  for (const id of missing) {
    const job = await db.getJob(id);
    if (!job?.idea) continue;
    try {
      const r = await ceoReview(job.idea);
      if (r) {
        await db.setCeoReview(id, r.rating, JSON.stringify(r.critique));
        log(`   ✓ ${id}: ${r.rating}⭐`);
        db.appendSystemLog("ceo", `${id}: ${r.rating}⭐ (backfill)`, "summary").catch(() => {});
        // Auto-approve nếu rating >= threshold config (mirror api/routes.ts).
        if (CONFIG.autoApproveMinRating > 0 && r.rating >= CONFIG.autoApproveMinRating) {
          await db.setStatus(id, "approved");
          db.appendSystemLog("auto-approve", `${id} → approved (${r.rating}⭐ ≥ ${CONFIG.autoApproveMinRating})`, "summary").catch(() => {});
        }
      } else {
        log(`   ✗ ${id}: CEO returned null (LLM cool?), sẽ thử cycle sau`);
      }
    } catch (e: any) {
      log(`   ✗ ${id}: ${e?.message ?? e}`);
    }
  }
}

export async function pollOnce(): Promise<void> {
  // 1) Deploy requests (không giới hạn theo ngày)
  let d = await db.claimNextDeployRequested();
  while (d) { await deploy(d.id); d = await db.claimNextDeployRequested(); }

  // 2) Backfill CEO review cho job proposed chưa có critique (LLM có thể đã cool down khi review async fail).
  try { await backfillCeoReviews(); }
  catch (e: any) { log(`(backfillCeoReviews err: ${e?.message ?? e})`); }

  // 3) Seed empty projects (LLM cần Claude auth — chỉ chạy trên worker Mac)
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
