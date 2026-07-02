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
import { runBuild, verifyBuildArtifacts } from "./executor/builder";
import { generateDetailedPlan, updatePlanStep } from "./executor/planner";
import { ceoReview, callTextWithFallback } from "./executor/ceo";
import { parseRateLimitReset } from "./util/rate-limit";
import { sendEmail, demoReadyEmail, deployedEmail } from "./util/email";


// =========================== DEPLOY ===============================
// Bạn bấm Deploy trên web (→deploy-requested). Poller chạy ship.sh trong build dir → push lên EC2, mở Caddy block.
const PUBLIC_PORT_BASE = 9000; // host port hashed từ slug để tránh đụng nhau
async function deploy(id: string): Promise<void> {
  const job = await db.getJob(id);
  if (!job) return;
  const idea = job.idea as Idea;
  const cwd = `${CONFIG.builds}/${id}`;
  const slug = idea.slug;
  const publicPort = PUBLIC_PORT_BASE + (Math.abs(hash(slug)) % 900);
  const domain = `${slug}.luunguyen.dev`;
  jLog(id, `🚀 DEPLOY → ${CONFIG.awsHost} — ${id}`);
  await updatePlanStep(id, "deploy", "in_progress");

  try {
    // 1) Verify build artifacts còn nguyên
    const missing = await verifyBuildArtifacts(cwd);
    if (missing.length) throw new Error(`thiếu artifact: ${missing.join(", ")}`);

    // 2) Ghi .shipenv cho ship.sh
    const env = process.env;
    const shipenv = [
      `SLUG=${slug}`,
      `EC2_HOST=${env.AWS_HOST}`,
      `EC2_USER=${env.SSH_USER ?? "ec2-user"}`,
      `SSH_KEY=${env.SSH_KEY}`,
      `PORT=${publicPort}`,
      `CADDY_DOMAIN=${domain}`,
    ].join("\n") + "\n";
    await Bun.write(`${cwd}/.shipenv`, shipenv);

    // 3) Chạy ship.sh — pipe + tail vào job_logs
    jLog(id, `[ship] bash ./ship.sh — domain=${domain} port=${publicPort}`);
    const proc = Bun.spawn(["bash", "./ship.sh"], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env } });
    const pipeToLog = async (stream: ReadableStream<Uint8Array>, isStderr: boolean) => {
      const reader = stream.getReader(); const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() ?? "";
        for (const l of lines) {
          if (!l.trim()) continue;
          (isStderr ? process.stderr : process.stdout).write(l + "\n");
          db.appendLog(id, l.slice(0, 400), isStderr ? "error" : "tool").catch(() => {});
        }
      }
    };
    await Promise.all([pipeToLog(proc.stdout as any, false), pipeToLog(proc.stderr as any, true)]);
    await proc.exited;
    if (proc.exitCode !== 0) throw new Error(`ship.sh exit ${proc.exitCode}`);

    const deployedUrl = `https://${domain}`;
    await db.setResult(id, { ...(job.result ?? {}), deployedUrl, publicPort }, "deployed");
    await updatePlanStep(id, "deploy", "done", deployedUrl);
    await sendEmail(`🚀 Đã deploy: ${idea.title}`, deployedEmail(idea, deployedUrl), "deployed");
    jLog(id, `✓ deployed · ${deployedUrl}`, "summary");
  } catch (e: any) {
    jLog(id, `[ship] FAILED: ${e?.message ?? e}`, "error");
    await updatePlanStep(id, "deploy", "failed", String(e?.message ?? e));
    await db.setResult(id, { ...(job.result ?? {}), error: String(e?.message ?? e) }, "failed");
  }
}

// =========================== POLLER ===============================
async function pollOnce(): Promise<void> {
  // 1) Deploy requests (không giới hạn theo ngày)
  let d = await db.claimNextDeployRequested();
  while (d) { await deploy(d.id); d = await db.claimNextDeployRequested(); }
  // 2) Seed empty projects (LLM cần Claude auth — chỉ chạy trên worker Mac)
  try { await seedEmptyProjects(); } catch (e: any) { log(`(seedEmptyProjects err: ${e?.message ?? e})`); }
  // 3) Build: tối đa DAILY_BUILD_LIMIT ý tưởng trong rolling BUILD_WINDOW_HOURS (default 24h).
  //    Claim tuần tự đến khi hit gate hoặc hết approved queue trong cùng cycle.
  while (true) {
    const inWindow = await db.countStartedRecent(CONFIG.buildWindowHours);
    if (inWindow >= CONFIG.dailyBuildLimit) {
      const oldest = await db.oldestStartedInWindow(CONFIG.buildWindowHours);
      const nextSlot = oldest ? new Date(new Date(oldest).getTime() + CONFIG.buildWindowHours * 3600 * 1000).toISOString() : "?";
      log(`⏭️  đã thực thi ${inWindow}/${CONFIG.dailyBuildLimit} trong ${CONFIG.buildWindowHours}h qua — slot tiếp theo mở lúc ${nextSlot}`);
      return;
    }
    const job = await db.claimNextApproved();
    if (!job) { log("⏳ chưa có ý tưởng status=approved"); return; }
    log(`▶️  build ${inWindow + 1}/${CONFIG.dailyBuildLimit} (rolling ${CONFIG.buildWindowHours}h): ${job.id}`);
    await runBuild(job.id);
  }
}

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

// Sinh 5-8 issues khởi tạo từ idea brief. Dùng MODEL_GATHERER (creative synthesis).
async function seedProjectIssues(projectId: string, idea: Idea): Promise<number> {
  const prompt = `Bạn đang lập backlog khởi đầu cho 1 dự án mới. Idea vừa được promote từ demo 1-day thành project long-term.

Idea:
- Title (EN): ${idea.title_en ?? idea.title}
- Title (VI): ${idea.title_vi ?? idea.title}
- Pitch: ${idea.pitch_en ?? idea.pitch}
- Features hiện có: ${(idea.features_en ?? []).join("; ") || "—"}
- Target user: ${idea.target_user_en ?? "—"}
- Risk: ${idea.risk_en ?? "—"}

Nhiệm vụ: sinh **5-8 issues** khởi tạo backlog. Phân bố:
- 3-5 feature (mở rộng scope 1-day → real product): tính năng còn thiếu để usable production
- 1-2 chore (setup CI/test/monitoring/docs cần cho long-term)
- 0-1 spike (nghi vấn kỹ thuật cần điều tra trước khi cam kết approach)

Mỗi issue song ngữ EN + VN. Priority p0..p3 (p0 blocker, p2 default, p3 nice-to-have).
Trả JSON array only, không markdown:
[{"type":"feature|bug|chore|spike|adr","priority":"p0|p1|p2|p3",
"title_en":"...","title_vi":"...","description_en":"3-5 câu spec + acceptance criteria","description_vi":"..."},...]`;
  try {
    const raw = await callLLM(CONFIG.modelGatherer, prompt, { num_predict: 16384, timeoutMs: 180_000 });
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) return 0;
    const items = JSON.parse(m[0]) as any[];
    let count = 0;
    for (const it of items.slice(0, 8)) {
      await db.createIssue({
        project_id: projectId,
        title: String(it.title_en ?? "Untitled"),
        title_vi: it.title_vi ?? null,
        description: String(it.description_en ?? ""),
        description_vi: String(it.description_vi ?? ""),
        type: (["feature", "bug", "chore", "spike", "adr"].includes(it.type) ? it.type : "feature") as any,
        priority: (["p0", "p1", "p2", "p3"].includes(it.priority) ? it.priority : "p2") as any,
        status: "backlog",
      });
      count++;
    }
    return count;
  } catch (e: any) {
    log(`   (seed issues fail: ${e?.message ?? e})`);
    return 0;
  }
}

// Promote nhanh: chỉ tạo project row (không seed issues — worker Mac có Claude auth sẽ seed sau).
async function promoteJobToProject(jobId: string): Promise<{ projectId: string; issues: number } | null> {
  const job = await db.getJob(jobId);
  if (!job || job.status !== "demo-ready") return null;
  const idea = job.idea as Idea;
  const slug = idea.slug;
  const existing = await db.getProjectBySlug(slug);
  if (existing) return { projectId: existing.id, issues: 0 };

  const projectId = `proj-${slug}-${Date.now().toString(36)}`;
  await db.createProject({
    id: projectId, source_job_id: jobId, slug,
    title: idea.title_en ?? idea.title,
    title_vi: idea.title_vi ?? null,
    description: idea.pitch_en ?? idea.pitch,
    status: "active",
    repo_url: job.result?.repoUrl ?? null,
    prod_domain: `${slug}.luunguyen.dev`,
    staging_domain: `staging-${slug}.luunguyen.dev`,
  });
  return { projectId, issues: 0 };  // worker sẽ seed sau
}

// Worker poll pick project chưa có issue → seed via LLM. Atomic claim (status active→seeding)
// tránh race giữa 2 poll process (launchd worker + manual poll).
async function seedEmptyProjects(): Promise<void> {
  const projects = await db.listProjects(20);
  for (const p of projects) {
    if (p.status !== "active") continue;
    const existing = await db.listIssues(p.id);
    if (existing.length > 0) continue;
    if (!p.source_job_id) continue;
    const claimed = await db.claimProjectForSeed(p.id);
    if (!claimed) continue;  // ai đó đã claim
    try {
      const job = await db.getJob(p.source_job_id);
      if (!job) { await db.setProjectStatus(p.id, "active"); continue; }
      log(`🌱 Seeding issues cho project ${p.slug} (từ job ${job.id})…`);
      const n = await seedProjectIssues(p.id, job.idea as Idea);
      log(`   → ${n} issues khởi tạo`);
    } finally {
      await db.setProjectStatus(p.id, "active");
    }
  }
}

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
