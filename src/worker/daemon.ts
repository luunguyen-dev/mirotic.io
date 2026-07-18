/**
 * daemon.ts — Prototyper batch scheduler + long-running daemon loops.
 *
 * Exports:
 *   - generateIdea(): 1 idea proposed rồi thoát (mode 'generate' + fallback trong demo mode)
 *   - generateIdeaBatch(): Prototyper enrich → CEO review parallel → top-K jobs, rest → pool
 *   - runDaemon(): server + morning batch schedule + poller interval
 *   - runWorker(): worker Mac — morning batch + poller, KHÔNG serve dashboard
 *   - msUntil(hhmm): compute delay tới HH:MM local next
 */

import { CONFIG } from "../config";
import * as db from "../db";
import { batchCollect, collectIdea } from "../prototyper";
import { ceoReview } from "../executor/ceo";
import { makePlan } from "../executor/planner";
import { pollOnce } from "./poller";
import { log } from "../util/logger";
import { startServer } from "../api/server";
import type { Idea, ScoredIdea } from "../types";

// Ngày địa phương UTC+7 — prefix cho pool ID, khớp bucket "hôm nay" của dashboard (client cũng UTC+7).
const today = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

// Single-idea path — giữ cho mode 'demo' + backward compat.
export async function generateIdea(): Promise<string> {
  log("☀️  Prototyper — gom & chọn ý tưởng…");
  const idea = await collectIdea();
  const plan = await makePlan(idea);
  const id = await db.insertJob(idea, plan);
  log(`   → đã thêm "${idea.title}" (${idea.type}) status=proposed [${id}]`);
  return id;
}

// Batch (mode 'daemon' / 'worker' mỗi sáng):
//   1) Prototyper enrich brief + score (LLM per role="prototyper")
//   2) CEO review từng idea parallel → rating 1-5 + critique
//   3) Sort rating desc → top-K → jobs(proposed), còn lại → idea_pool
type Reviewed = ScoredIdea & { ceo_rating?: number; ceo_critique?: string };

export async function generateIdeaBatch(n = 10, topK = 3): Promise<{ jobIds: string[]; pooled: number }> {
  log(`☀️  Prototyper batch — gom ${n} candidates…`);
  db.appendSystemLog("prototyper", `Batch start — gom ${n} candidates`, "summary").catch(() => {});
  // Dedup context: title+pitch của jobs + pool gần đây → Prototyper không đề xuất lại.
  const existing = await db.listRecentIdeaTitles(60).catch(() => []);
  const candidates: ScoredIdea[] = await batchCollect(n, existing);
  // Synthesis fail → batchCollect trả rỗng (không phun tiêu đề thô làm idea rác). Bỏ qua batch,
  // nhưng VẪN chạy auto-build để card tốt tồn đọng được thực thi. Mai batch retry.
  if (!candidates.length) {
    log(`   ⚠️  Batch rỗng (Prototyper synthesis fail) — không thêm idea mới hôm nay`);
    db.appendSystemLog("prototyper", "Batch rỗng — Prototyper synthesis fail (không tạo idea rác). Mai retry.", "warn").catch(() => {});
    if (CONFIG.dailyAutoBuild) await autoPromoteBest();
    return { jobIds: [], pooled: 0 };
  }
  log(`   gom được ${candidates.length} candidates (score ${candidates[0]?.score.toFixed(2) ?? "—"} → ${candidates.at(-1)?.score.toFixed(2) ?? "—"})`);
  db.appendSystemLog("prototyper", `Batch gom ${candidates.length} candidates (score ${candidates[0]?.score.toFixed(2) ?? "—"} → ${candidates.at(-1)?.score.toFixed(2) ?? "—"})`, "summary").catch(() => {});

  // CEO review song song (10 items × ~3-8s Claude) — timeout mỗi call 60s.
  log(`🏛  CEO review ${candidates.length} candidates (Claude, parallel)…`);
  db.appendSystemLog("ceo", `Review ${candidates.length} candidates parallel`, "summary").catch(() => {});
  const reviews = await Promise.all(candidates.map((c) => ceoReview(c)));
  const reviewed: Reviewed[] = candidates.map((c, i) => ({
    ...c,
    ceo_rating: reviews[i]?.rating,
    ceo_critique: reviews[i] ? JSON.stringify(reviews[i]!.critique) : undefined,
  }));

  // Sort: rating desc, tie-break bằng ollama score.
  reviewed.sort((a, b) => (b.ceo_rating ?? 0) - (a.ceo_rating ?? 0) || b.score - a.score);
  const withRating = reviewed.filter((r) => r.ceo_rating).length;
  log(`   CEO OK: ${withRating}/${reviewed.length}. Top-3 rating: ${reviewed.slice(0, 3).map((r) => r.ceo_rating ?? "?").join(", ")}`);
  db.appendSystemLog("ceo", `Done: ${withRating}/${reviewed.length} rated. Top-3: ${reviewed.slice(0, 3).map((r) => r.ceo_rating ?? "?").join(", ")}⭐`, "summary").catch(() => {});

  const jobIds: string[] = [];
  for (const c of reviewed.slice(0, topK)) {
    const plan = await makePlan(c);
    const id = await db.insertJob(c, plan);
    db.appendSystemLog("planner", `Plan sinh cho ${id} (${c.title})`, "summary").catch(() => {});
    if (c.ceo_rating) await db.setCeoReview(id, c.ceo_rating, c.ceo_critique ?? "");
    // Auto-approve nếu CEO rating >= threshold (config).
    if (CONFIG.autoApproveMinRating > 0 && c.ceo_rating && c.ceo_rating >= CONFIG.autoApproveMinRating) {
      await db.setStatus(id, "approved");
      log(`   ✓ auto-approved (rating ${c.ceo_rating} >= ${CONFIG.autoApproveMinRating})`);
      db.appendSystemLog("auto-approve", `${id} → approved (${c.ceo_rating}⭐ ≥ ${CONFIG.autoApproveMinRating})`, "summary").catch(() => {});
    }
    jobIds.push(id);
    log(`   → job ${id} "${c.title}" (${c.ceo_rating ?? "?"}⭐ · score ${c.score.toFixed(2)})`);
    db.appendSystemLog("prototyper", `Job promoted: ${id} "${c.title}" (${c.ceo_rating ?? "?"}⭐)`, "summary").catch(() => {});
  }
  let pooled = 0;
  for (const c of reviewed.slice(topK)) {
    await db.insertPoolItem({
      id: `${today()}-${c.slug}-${c.source.replace(/\W/g, "")}`,
      title: c.title, pitch: c.pitch, why: c.why, source: c.source,
      url: c.url ?? null, type: c.type, score: c.score,
      title_vi: c.title_vi ?? null, pitch_vi: c.pitch_vi ?? null, why_vi: c.why_vi ?? null,
      title_en: c.title_en ?? null, pitch_en: c.pitch_en ?? null, why_en: c.why_en ?? null,
      ceo_rating: c.ceo_rating ?? null, ceo_critique: c.ceo_critique ?? null,
    });
    pooled++;
  }
  log(`   → pool: ${pooled} candidates`);
  db.appendSystemLog("prototyper", `Batch done: ${topK} jobs + ${pooled} pool`, "summary").catch(() => {});

  // Daily auto-build: sau khi batch có rating, tự approve đúng 1 card tốt nhất (nếu bật).
  if (CONFIG.dailyAutoBuild) await autoPromoteBest();
  return { jobIds, pooled };
}

// Mỗi ngày: chọn đúng 1 card status=proposed có CEO rating cao nhất (floor = autoApproveMinRating)
// → approved. Poller sẽ nhận build ở cycle kế. Không làm gì nếu không còn card đủ điều kiện.
export async function autoPromoteBest(): Promise<string | null> {
  const job = await db.claimBestProposed(CONFIG.autoApproveMinRating);
  if (!job) {
    log(`🤖 Daily auto-build: không có card proposed đủ điều kiện (floor ${CONFIG.autoApproveMinRating}⭐)`);
    return null;
  }
  log(`🤖 Daily auto-build: approved "${job.idea.title}" (${job.ceo_rating ?? "?"}⭐) [${job.id}]`);
  db.appendSystemLog("auto-approve", `Daily best → approved: ${job.id} "${job.idea.title}" (${job.ceo_rating ?? "?"}⭐)`, "summary").catch(() => {});
  return job.id;
}

// Compute ms từ now → HH:MM local kế tiếp (roll qua ngày mai nếu đã qua).
export function msUntil(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

// Daemon = server + morning batch + poller interval (dùng cho container).
export async function runDaemon(): Promise<void> {
  await db.initDb();
  startServer();
  if (!(await db.listJobs(1)).length) await generateIdeaBatch();  // batch sáng đầu tiên nếu DB rỗng
  const sched = () => setTimeout(async () => { await generateIdeaBatch(); sched(); }, msUntil(CONFIG.morningAt));
  sched();
  await pollOnce();
  setInterval(pollOnce, CONFIG.pollIntervalMin * 60_000);
  log(`🟢 Daemon: poller mỗi ${CONFIG.pollIntervalMin} phút · batch ý tưởng lúc ${CONFIG.morningAt} · daily-auto-build: ${CONFIG.dailyAutoBuild ? `ON (floor ${CONFIG.autoApproveMinRating}⭐)` : "off"}`);
}

// Worker Mac = CHỈ poller (build/deploy queue), KHÔNG serve dashboard (dashboard ở EC2).
// Batch ý tưởng KHÔNG còn chạy bằng setTimeout in-process (không tin cậy khi Mac ngủ —
// timer chỉ fire khi máy thức, trễ hàng giờ). Thay bằng launchd job riêng `io.mirotic.batch`
// với StartCalendarInterval (chạy đúng giờ, và chạy bù ngay khi máy thức nếu lỡ giờ vì ngủ).
export async function runWorker(): Promise<void> {
  await db.initDb();
  await pollOnce();
  setInterval(pollOnce, CONFIG.pollIntervalMin * 60_000);
  log(`🛠  Worker: poller mỗi ${CONFIG.pollIntervalMin}' · batch qua launchd io.mirotic.batch lúc ${CONFIG.morningAt} · daily-auto-build: ${CONFIG.dailyAutoBuild ? `ON (floor ${CONFIG.autoApproveMinRating}⭐)` : "off"} · KHÔNG serve dashboard`);
}
