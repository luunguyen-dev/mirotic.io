/**
 * mirotic.ts — Orchestrator điều khiển bởi DATABASE (web là UI).
 *
 * Luồng: Prototyper sinh ý tưởng (status=proposed) → bạn duyệt trên web (→approved)
 *  → poller mỗi 5' nhận (1 ý tưởng/ngày) → build → demo-ready (docker chạy local + repo
 *  private + CI/CD) → bạn test ở nhà → bấm Deploy trên web (→deploy-requested) → deploy AWS.
 *
 * Modes:
 *   bun run mirotic.ts daemon    # server + sinh ý tưởng hằng ngày + poller 5' (mặc định Docker)
 *   bun run mirotic.ts demo      # 1 vòng đầy đủ trong bộ nhớ, mock (~6s)
 *   bun run mirotic.ts generate  # sinh 1 ý tưởng proposed rồi thoát
 *   bun run mirotic.ts poll       # chạy 1 chu kỳ poller rồi thoát
 *   bun run mirotic.ts serve      # chỉ dashboard + action endpoints
 */

import { mkdirSync } from "node:fs";
import { collectIdea, batchCollect } from "./prototyper";
import type { Idea, ScoredIdea } from "./types";
import * as db from "./db";

const env = (k: string, d = "") => process.env[k] ?? d;
const bool = (k: string, d = false) => (process.env[k] ?? String(d)) === "true";

const DATA_DIR = env("DATA_DIR", "./data");
const CONFIG = {
  port: Number(env("PORT", "4321")),
  baseUrl: env("BASE_URL", "http://localhost:4321"),
  hmacSecret: env("HMAC_SECRET", "change-me-in-prod"),
  morningAt: env("MORNING_AT", "07:00"),
  pollIntervalMin: Number(env("POLL_INTERVAL_MIN", "5")),
  dailyBuildLimit: Number(env("DAILY_BUILD_LIMIT", "3")),  // giữ tên cũ, semantic đã đổi sang rolling 24h
  buildWindowHours: Number(env("BUILD_WINDOW_HOURS", "24")),
  githubOwner: env("GITHUB_OWNER", "you"),
  awsHost: env("AWS_HOST", "your-ec2-host"),
  outbox: `${DATA_DIR}/outbox`,
  builds: `${DATA_DIR}/builds`,
  useRealClaude: bool("USE_REAL_CLAUDE", false),
  // Model per role/skill — swap qua env không cần build lại.
  modelGatherer: env("MODEL_GATHERER", "claude-haiku-4-5-20251001"),
  modelCeo:      env("MODEL_CEO",      "claude-sonnet-4-6"),
  modelPlanner:  env("MODEL_PLANNER",  "claude-haiku-4-5-20251001"),
  modelBuilder:  env("MODEL_BUILDER",  "claude-sonnet-4-6"),
  modelReviewer: env("MODEL_REVIEWER", "claude-haiku-4-5-20251001"),
  modelCso:      env("MODEL_CSO",      "claude-sonnet-4-6"),
  modelQa:       env("MODEL_QA",       "claude-haiku-4-5-20251001"),
  resendApiKey: env("RESEND_API_KEY"),
  emailFrom: env("EMAIL_FROM", "mirotic@example.com"),
  emailTo: env("EMAIL_TO"),
};
mkdirSync(CONFIG.outbox, { recursive: true });
mkdirSync(CONFIG.builds, { recursive: true });

type PlanStep = { key: string; label_en: string; label_vi: string; status: "pending" | "in_progress" | "done" | "failed"; note?: string };
type Plan = {
  problem: string; tenStar: string; scopeCut: string; stack: string;
  buildSteps: string[]; testPlan: string[]; tasteDecisions: string[];
  steps?: PlanStep[];      // checklist tracking (generated on Approve)
};
type Result = {
  repoUrl: string; branch: string; localUrl: string;
  deployedUrl?: string; publicPort?: number; error?: string;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (s = "") => console.log(s);
// Log dòng vào cả console + job_logs (fire-and-forget nếu DB fail).
const jLog = (jobId: string, msg: string, level = "info") => {
  console.log(msg);
  db.appendLog(jobId, msg, level).catch(() => {});
};

// ===================== INTEGRATION SEAMS ===========================
import { runBuild } from "./executor/builder";
import { deploy } from "./executor/deployer";
import { generateDetailedPlan, updatePlanStep, makePlan } from "./executor/planner";
import { ceoReview } from "./executor/ceo";
import { pollOnce } from "./worker/poller";
import { promoteJobToProject } from "./projects";
import { startServer } from "./api/server";


// ====================== SINH Ý TƯỞNG ==============================
// Single (giữ cho mode 'demo' và backward compat)
async function generateIdea(): Promise<string> {
  log("☀️  Prototyper — gom & chọn ý tưởng…");
  const idea = await collectIdea();
  const plan = await makePlan(idea);
  const id = await db.insertJob(idea, plan);
  log(`   → đã thêm "${idea.title}" (${idea.type}) status=proposed [${id}]`);
  return id;
}

// Batch (mode 'daemon' mỗi sáng):
//   1) Prototyper (Ollama) enrich brief + score
//   2) CEO review (Claude) từng idea → rating 1-5 + critique
//   3) Sort by CEO rating desc → top-K → jobs(proposed), còn lại → idea_pool
type Reviewed = ScoredIdea & { ceo_rating?: number; ceo_critique?: string };

async function generateIdeaBatch(n = 10, topK = 3): Promise<{ jobIds: string[]; pooled: number }> {
  log(`☀️  Prototyper batch — gom ${n} candidates…`);
  const candidates: ScoredIdea[] = await batchCollect(n);
  log(`   gom được ${candidates.length} candidates (score ${candidates[0]?.score.toFixed(2) ?? "—"} → ${candidates.at(-1)?.score.toFixed(2) ?? "—"})`);

  // CEO review song song (10 items × ~3-8s Claude) — timeout mỗi call 60s.
  log(`🏛  CEO review ${candidates.length} candidates (Claude, parallel)…`);
  const reviews = await Promise.all(candidates.map(c => ceoReview(c)));
  const reviewed: Reviewed[] = candidates.map((c, i) => ({
    ...c,
    ceo_rating: reviews[i]?.rating,
    ceo_critique: reviews[i] ? JSON.stringify(reviews[i]!.critique) : undefined,
  }));

  // Sort: rating desc, tie-break bằng ollama score.
  reviewed.sort((a, b) => (b.ceo_rating ?? 0) - (a.ceo_rating ?? 0) || b.score - a.score);
  const withRating = reviewed.filter(r => r.ceo_rating).length;
  log(`   CEO OK: ${withRating}/${reviewed.length}. Top-3 rating: ${reviewed.slice(0, 3).map(r => r.ceo_rating ?? "?").join(", ")}`);

  const jobIds: string[] = [];
  for (const c of reviewed.slice(0, topK)) {
    const plan = await makePlan(c);
    const id = await db.insertJob(c, plan);
    if (c.ceo_rating) await db.setCeoReview(id, c.ceo_rating, c.ceo_critique ?? "");
    jobIds.push(id);
    log(`   → job ${id} "${c.title}" (${c.ceo_rating ?? "?"}⭐ · score ${c.score.toFixed(2)})`);
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
  return { jobIds, pooled };
}

const today = () => new Date().toISOString().slice(0, 10);


// ========================= SCHEDULER ==============================
function msUntil(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  const now = new Date(); const next = new Date(now);
  next.setHours(h, m, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

// ============================= MAIN ===============================
async function daemon() {
  await db.initDb();
  startServer();
  if (!(await db.listJobs(1)).length) await generateIdeaBatch(); // batch sáng đầu tiên nếu DB rỗng
  const sched = () => setTimeout(async () => { await generateIdeaBatch(); sched(); }, msUntil(CONFIG.morningAt));
  sched();
  await pollOnce();
  setInterval(pollOnce, CONFIG.pollIntervalMin * 60_000);
  log(`🟢 Daemon: poller mỗi ${CONFIG.pollIntervalMin} phút · batch ý tưởng lúc ${CONFIG.morningAt}`);
}

async function main() {
  const mode = process.argv[2] ?? "daemon";
  if (mode === "daemon") return daemon();
  if (mode === "serve") { await db.initDb(); return startServer(); }
  if (mode === "generate") { await db.initDb(); await generateIdea(); return db.closeDb(); }
  if (mode === "batch") { await db.initDb(); await generateIdeaBatch(); return db.closeDb(); }
  if (mode === "poll") { await db.initDb(); await pollOnce(); return db.closeDb(); }
  if (mode === "worker") {
    // Mac native: batch sáng + poller, KHÔNG serve dashboard (dashboard ở EC2).
    await db.initDb();
    const sched = () => setTimeout(async () => { await generateIdeaBatch(); sched(); }, msUntil(CONFIG.morningAt));
    sched();
    await pollOnce();
    setInterval(pollOnce, CONFIG.pollIntervalMin * 60_000);
    log(`🛠  Worker: poller mỗi ${CONFIG.pollIntervalMin}' · batch lúc ${CONFIG.morningAt} · KHÔNG serve dashboard`);
    return;
  }

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
