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

import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { collectIdea, batchCollect } from "./prototyper";
import type { Idea, ProjectType, ScoredIdea } from "./types";
import * as db from "./db";
import type { JobStatus } from "./db";

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
import { callLLM, isGpt } from "./llm";
import * as registry from "./llm/registry";
import { runBuild } from "./executor/builder";
import { deploy } from "./executor/deployer";
import { generateDetailedPlan, updatePlanStep, makePlan } from "./executor/planner";
import { ceoReview } from "./executor/ceo";
import { pollOnce } from "./worker/poller";
import { promoteJobToProject } from "./projects";


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

// ============================ SERVER ==============================
const sign = (id: string, a: string) => createHmac("sha256", CONFIG.hmacSecret).update(`${id}:${a}`).digest("hex");
const verify = (id: string, a: string, t: string) => sign(id, a) === t;
const hash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; };
const page = (b: string, status = 200) =>
  new Response(`<meta charset=utf8><body style="font-family:system-ui;padding:32px;max-width:760px">${b}</body>`, { status, headers: { "Content-Type": "text/html" } });

const ACTIONS: Record<string, JobStatus> = { approve: "approved", reject: "rejected", deploy: "deploy-requested" };
// Promote không đổi status của job — chỉ tạo project row. Handler riêng.
const PROMOTE_ACTION = "promote";
// Retry: reset failed/waiting job → approved, clear retry_after để poller pick ngay.
const RETRY_ACTION = "retry";

// Model builder user có thể pick khi Approve. Key = short name hiển thị; value = model name gửi CLI.
// Mở rộng khi wire gpt-5.5 / gemini agentic mượt: chỉ thêm 1 entry.
const BUILDER_CHOICES: Record<string, string> = {
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-4-8",
};

function startServer() {
  Bun.serve({
    port: CONFIG.port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // ─── JSON API ────────────────────────────────────────────
      if (path === "/api/jobs") {
        const jobs = await db.listJobs(200);
        const detailed = await Promise.all(jobs.map(async (j) => {
          const full = await db.getJob(j.id);
          return full ? { id: full.id, status: full.status, created_at: full.created_at,
            started_at: full.started_at, error_detail: full.error_detail,
            title: full.idea?.title, slug: full.idea?.slug, type: full.idea?.type,
            pitch: full.idea?.pitch, source: full.idea?.source,
            idea: full.idea, plan: full.plan,
            ceo_rating: full.ceo_rating, ceo_critique: full.ceo_critique,
            builder_model: full.builder_model, retry_after: full.retry_after,
            result: full.result,
            signs: {
              approve: sign(full.id, "approve"),
              reject: sign(full.id, "reject"),
              deploy: sign(full.id, "deploy"),
              promote: sign(full.id, "promote"),
              retry: sign(full.id, "retry"),
            },
          } : null;
        }));
        return Response.json(detailed.filter(Boolean));
      }
      // GET /api/jobs/:id/logs?since=N — trả entries mới sau id N
      if (path.startsWith("/api/jobs/") && path.endsWith("/logs")) {
        const jobId = path.slice("/api/jobs/".length, -"/logs".length);
        const since = Number(url.searchParams.get("since") ?? "0") | 0;
        const logs = await db.getLogs(jobId, since, 500);
        return Response.json(logs);
      }
      if (path.startsWith("/api/jobs/")) {
        const job = await db.getJob(path.slice("/api/jobs/".length));
        if (!job) return new Response("not found", { status: 404 });
        return Response.json({ ...job,
          signs: {
            approve: sign(job.id, "approve"), reject: sign(job.id, "reject"),
            deploy: sign(job.id, "deploy"), promote: sign(job.id, "promote"),
            retry: sign(job.id, "retry"),
          },
        });
      }
      if (path === "/api/pool") {
        return Response.json(await db.listPool(100));
      }
      if (path === "/api/builder-choices") {
        return Response.json({ choices: BUILDER_CHOICES, default: "sonnet" });
      }
      // Model registry state — dashboard hiển thị cooldown.
      if (path === "/api/models") {
        await registry.refreshCooldowns();
        const cds = registry.getCooldowns();
        const models = Object.values(registry.MODELS).map(m => ({
          model: m.name, tier: m.tier,
          cooldown_until: cds[m.name] ?? null,
          available: !cds[m.name] || cds[m.name] <= new Date().toISOString(),
        }));
        return Response.json({
          models,
          agentic_priority: registry.AGENTIC_PRIORITY,
          text_priority: registry.TEXT_PRIORITY,
        });
      }
      // Snapshot trạng thái hệ thống — dashboard hiển thị 1 dòng tóm tắt.
      if (path === "/api/status") {
        const jobs = await db.listJobs(500);
        const detailed = await Promise.all(jobs.map((j) => db.getJob(j.id)));
        const all = detailed.filter(Boolean) as any[];
        const startedInWindow = await db.countStartedRecent(CONFIG.buildWindowHours);
        const oldestInWindow = await db.oldestStartedInWindow(CONFIG.buildWindowHours);
        // "Today" cho failed count vẫn giữ calendar-day để tương thích với thói quen.
        const todayPrefix = new Date().toISOString().slice(0, 10);
        const nowIso = new Date().toISOString();
        const counts = {
          proposed: all.filter((j) => j.status === "proposed").length,
          approved: all.filter((j) => j.status === "approved" && (!j.retry_after || j.retry_after <= nowIso)).length,
          waitingRetry: all.filter((j) => j.status === "approved" && j.retry_after && j.retry_after > nowIso).length,
          building: all.filter((j) => j.status === "building").length,
          demoReady: all.filter((j) => j.status === "demo-ready").length,
          deployRequested: all.filter((j) => j.status === "deploy-requested").length,
          deploying: all.filter((j) => j.status === "deploying").length,
          failedToday: all.filter((j) => j.status === "failed" && j.started_at?.startsWith(todayPrefix)).length,
        };
        const soonestRetry = all
          .filter((j) => j.status === "approved" && j.retry_after && j.retry_after > nowIso)
          .map((j) => j.retry_after!)
          .sort()[0] ?? null;
        const running = all
          .filter((j) => j.status === "building" || j.status === "deploying")
          .map((j) => ({ id: j.id, title: j.idea?.title, status: j.status, started_at: j.started_at, builder_model: j.builder_model }));
        // Next Prototyper batch — parse HH:MM, đưa về UTC ISO
        const [h, m] = CONFIG.morningAt.split(":").map(Number);
        const nowD = new Date();
        const next = new Date(nowD);
        next.setUTCHours(h - 7 < 0 ? h - 7 + 24 : h - 7, m, 0, 0);  // MORNING_AT = giờ VN, convert UTC (VN = UTC+7)
        if (next <= nowD) next.setUTCDate(next.getUTCDate() + 1);
        const nextSlotAt = (startedInWindow >= CONFIG.dailyBuildLimit && oldestInWindow)
          ? new Date(new Date(oldestInWindow).getTime() + CONFIG.buildWindowHours * 3600 * 1000).toISOString()
          : null;
        // Model cooldown snapshot
        await registry.refreshCooldowns();
        const cds = registry.getCooldowns();
        const cooldownCount = Object.keys(cds).filter(m => cds[m] > new Date().toISOString()).length;
        const soonestCooldownReset = Object.values(cds).filter(v => v > new Date().toISOString()).sort()[0] ?? null;

        return Response.json({
          startedInWindow, dailyLimit: CONFIG.dailyBuildLimit, buildWindowHours: CONFIG.buildWindowHours,
          counts, running,
          nextBatchAt: next.toISOString(),
          nextSlotAt,
          soonestRetryAt: soonestRetry,
          modelCooldowns: cooldownCount,          // số model đang cooling down
          soonestModelReset: soonestCooldownReset, // ISO ts reset sớm nhất
          morningAt: CONFIG.morningAt,
          pollIntervalMin: CONFIG.pollIntervalMin,
        });
      }
      // P1 — projects + issues API
      if (path === "/api/projects") {
        return Response.json(await db.listProjects(100));
      }
      if (path.startsWith("/api/projects/") && path.endsWith("/issues")) {
        const projectId = path.slice("/api/projects/".length, -"/issues".length);
        return Response.json(await db.listIssues(projectId));
      }
      if (path.startsWith("/api/projects/")) {
        const p = await db.getProject(path.slice("/api/projects/".length));
        if (!p) return new Response("not found", { status: 404 });
        const issues = await db.listIssues(p.id);
        return Response.json({ ...p, issues });
      }

      // ─── Static views ────────────────────────────────────────
      // Root → redirect to /ideas (Kanban board).
      if (path === "/" || path === "/index.html") {
        return Response.redirect("/ideas", 302);
      }
      if (path === "/ideas" || path === "/ideas/") {
        const html = await Bun.file(`${import.meta.dir}/../web/ideas.html`).text().catch(() => null);
        if (html) return new Response(html, { headers: { "Content-Type": "text/html" } });
      }
      if (path === "/projects" || path.startsWith("/projects/")) {
        const html = await Bun.file(`${import.meta.dir}/../web/projects.html`).text().catch(() => null);
        if (html) return new Response(html, { headers: { "Content-Type": "text/html" } });
      }

      // ─── HMAC action routes (giữ tương thích email link) ─────
      const [, action, id] = path.split("/");
      // Promote: demo-ready job → project + seeded issues
      if (action === PROMOTE_ACTION && id) {
        if (!verify(id, PROMOTE_ACTION, url.searchParams.get("t") ?? "")) return page("❌ Token sai", 403);
        const r = await promoteJobToProject(id);
        if (!r) return page(`❌ Không thể promote ${id}: chỉ demo-ready mới promote được`, 400);
        return Response.json({ ok: true, project_id: r.projectId, issues: r.issues });
      }
      // Retry: reset job → approved, xóa retry_after để poller pick ngay.
      // Áp dụng cho: failed (build fail) | approved còn trong retry window (skip wait) | rejected (đổi ý).
      if (action === RETRY_ACTION && id) {
        if (!verify(id, RETRY_ACTION, url.searchParams.get("t") ?? "")) return page("❌ Token sai", 403);
        const j = await db.getJob(id);
        if (!j) return page("❌ Không thấy job", 404);
        if (!["failed", "approved", "rejected"].includes(j.status)) {
          return page(`❌ Chỉ retry được failed/approved/rejected. Status hiện tại: ${j.status}`, 400);
        }
        // Requeue với retry_after=now-1s (clear window). Kèm note ai retry manually.
        await db.requeueWithRetry(id, new Date(Date.now() - 1000).toISOString(), "manual retry");
        return Response.json({ ok: true, id, new_status: "approved" });
      }
      if (action in ACTIONS) {
        if (!verify(id, action, url.searchParams.get("t") ?? "")) return page("❌ Token sai", 403);
        if (!(await db.getJob(id))) return page("❌ Không thấy job", 404);
        // Approve: cho phép user pick builder model qua ?model=<key> (whitelist BUILDER_CHOICES).
        if (action === "approve") {
          const modelKey = url.searchParams.get("model");
          if (modelKey) {
            const modelName = BUILDER_CHOICES[modelKey];
            if (!modelName) return page(`❌ Unknown builder model: ${modelKey}. Valid: ${Object.keys(BUILDER_CHOICES).join(", ")}`, 400);
            await db.setBuilderModel(id, modelName);
          }
        }
        await db.setStatus(id, ACTIONS[action]);
        return page(`✅ <code>${id}</code> → <b>${ACTIONS[action]}</b>. <a href="/">← dashboard</a>`);
      }
      return page("❌ 404", 404);
    },
  });
  log(`🌐 Dashboard: ${CONFIG.baseUrl}`);
}
const act = (id: string, a: string) =>
  `<a href="/${a}/${id}?t=${sign(id, a)}">${a}</a>`;

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
