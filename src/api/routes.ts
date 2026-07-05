/**
 * routes.ts — Bun.serve fetch handler với tất cả HTTP routes.
 *
 * Groups:
 *   - JSON API: /api/jobs, /api/status, /api/models, /api/pool, /api/projects, /api/builder-choices
 *   - Static: /ideas (redirect from /), /projects (SPA)
 *   - HMAC action: /approve, /reject, /deploy, /promote, /retry — token verify + state mutation
 */

import { CONFIG } from "../config";
import * as db from "../db";
import * as registry from "../llm/registry";
import { promoteJobToProject } from "../projects";
import { expandUserIdea } from "../prototyper";
import { ceoReview } from "../executor/ceo";
import { makePlan } from "../executor/planner";
import {
  sign, verify, jobSigns,
  ACTIONS, PROMOTE_ACTION, RETRY_ACTION, CANCEL_ACTION, BUILDER_CHOICES, BUILDER_DEFAULT,
} from "./hmac";

// Compute recommended agentic model NGAY LÚC NÀY cho 1 job (dựa CEO rating + cooldown).
// Chỉ tính khi status=proposed → dashboard preview cho user thấy Auto sẽ pick gì.
async function computeAutoRecommended(job: any): Promise<{ model: string; meta: any } | null> {
  if (!job?.ceo_rating && job?.ceo_rating !== 0) return null;
  const complexity = registry.complexityFromRating(job.ceo_rating);
  try {
    const model = await registry.pickModel("agentic", complexity);
    // Meta = entry trong BUILDER_CHOICES nếu có, fallback raw id.
    const meta = (BUILDER_CHOICES as any)[model] || { name: model };
    return { model, meta };
  } catch { return null; }   // ALL_COOLDOWN
}

// Simple HTML response helper for HMAC action confirmation pages.
export const page = (body: string, status = 200) =>
  new Response(`<meta charset=utf8><body style="font-family:system-ui;padding:32px;max-width:760px">${body}</body>`,
    { status, headers: { "Content-Type": "text/html" } });

// Serve HTML static file với error fallback 404.
async function serveStatic(filePath: string): Promise<Response | null> {
  const html = await Bun.file(filePath).text().catch(() => null);
  if (!html) return null;
  return new Response(html, { headers: { "Content-Type": "text/html" } });
}

// ─── Heatmap cache ─────────────────────────────────────
// Aggregate GitHub public events của account chính (luunguyen-dev) — bin theo giờ 0-23,
// normalize [0..1]. Cache 1h in-memory. Fail → dùng stale cached; ô 23 (mới nhất) = 0.
type HeatmapEntry = { ts: number; hours: number[]; stale?: boolean };
let heatmapCache: HeatmapEntry | null = null;
const HEATMAP_TTL_MS = 60 * 60 * 1000;
const HEATMAP_USER = process.env.HEATMAP_USER || CONFIG.githubOwner || "luunguyen-dev";

async function fetchUserEventHours(user: string): Promise<number[]> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  const tok = process.env.GITHUB_TOKEN;
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const res = await fetch(`https://api.github.com/users/${user}/events?per_page=100`,
    { headers, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`GitHub ${res.status}`);
  const events = (await res.json()) as Array<{ created_at?: string; type?: string; payload?: any }>;
  const hours = new Array(24).fill(0);
  for (const ev of events) {
    if (!ev.created_at) continue;
    // PushEvent: mỗi commit trong payload.commits = 1 điểm. Event khác = 0.5 điểm.
    const weight = ev.type === "PushEvent" ? (ev.payload?.commits?.length ?? 1) : 0.5;
    const d = new Date(ev.created_at);
    if (!isNaN(d.getTime())) hours[d.getUTCHours()] += weight;
  }
  const max = Math.max(1, ...hours);
  return hours.map((h) => h / max);
}

async function getHeatmap(_jobId: string): Promise<Response> {
  const fresh = heatmapCache && Date.now() - heatmapCache.ts < HEATMAP_TTL_MS && !heatmapCache.stale;
  if (fresh) return Response.json({ user: HEATMAP_USER, hours: heatmapCache!.hours, cached: true });
  try {
    const hours = await fetchUserEventHours(HEATMAP_USER);
    heatmapCache = { ts: Date.now(), hours };
    return Response.json({ user: HEATMAP_USER, hours, cached: false });
  } catch (e: any) {
    if (heatmapCache) {
      const stale = [...heatmapCache.hours];
      stale[23] = 0;
      heatmapCache.stale = true;
      return Response.json({ user: HEATMAP_USER, hours: stale, cached: true, stale: true, error: String(e?.message ?? e) });
    }
    return Response.json({ user: HEATMAP_USER, hours: new Array(24).fill(0), error: String(e?.message ?? e) });
  }
}

export async function handleFetch(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // ─── JSON API ────────────────────────────────────────────
  if (path === "/api/jobs") {
    const jobs = await db.listJobs(200);
    const detailed = await Promise.all(jobs.map(async (j) => {
      const full = await db.getJob(j.id);
      return full ? {
        id: full.id, status: full.status, created_at: full.created_at,
        started_at: full.started_at, error_detail: full.error_detail,
        title: full.idea?.title, slug: full.idea?.slug, type: full.idea?.type,
        pitch: full.idea?.pitch, source: full.idea?.source,
        idea: full.idea, plan: full.plan,
        ceo_rating: full.ceo_rating, ceo_critique: full.ceo_critique,
        builder_model: full.builder_model, builder_model_used: full.builder_model_used, retry_after: full.retry_after,
        total_cost_usd: full.total_cost_usd, total_turns: full.total_turns,
        result: full.result,
        signs: jobSigns(full.id),
      } : null;
    }));
    return Response.json(detailed.filter(Boolean));
  }
  // GET /api/events?since=N&limit=N — cross-cut summary/error logs mọi job (event stream).
  if (path === "/api/events") {
    const since = Number(url.searchParams.get("since") ?? "0") | 0;
    const limit = Math.min(200, Number(url.searchParams.get("limit") ?? "50") | 0 || 50);
    return Response.json(await db.getEvents(since, limit));
  }
  // GET /api/jobs/:id/logs?since=N — trả entries mới sau id N
  if (path.startsWith("/api/jobs/") && path.endsWith("/logs")) {
    const jobId = path.slice("/api/jobs/".length, -"/logs".length);
    const since = Number(url.searchParams.get("since") ?? "0") | 0;
    return Response.json(await db.getLogs(jobId, since, 500));
  }
  if (path.startsWith("/api/jobs/")) {
    const job = await db.getJob(path.slice("/api/jobs/".length));
    if (!job) return new Response("not found", { status: 404 });
    // Preview: model sẽ được Auto pick ngay lúc này (chỉ cho status=proposed).
    const auto_recommended = job.status === "proposed" ? await computeAutoRecommended(job) : null;
    return Response.json({ ...job, signs: jobSigns(job.id), auto_recommended });
  }
  if (path === "/api/pool") return Response.json(await db.listPool(100));
  // GET /api/heatmap — GitHub events của HEATMAP_USER bin theo giờ, cache 1h, stale fallback.
  if (path === "/api/heatmap" || path.startsWith("/api/heatmap/")) {
    return await getHeatmap("");
  }
  // POST /api/ideas/manual — user nhập keyword/description, Prototyper enrich + CEO review + insert.
  // Body: { input: string }
  if (path === "/api/ideas/manual" && req.method === "POST") {
    const body = await req.json().catch(() => null) as { input?: string } | null;
    const input = body?.input?.trim();
    if (!input || input.length < 3) return Response.json({ error: "input phải >= 3 ký tự" }, { status: 400 });
    if (input.length > 4000) return Response.json({ error: "input tối đa 4000 ký tự" }, { status: 400 });
    try {
      const idea = await expandUserIdea(input);
      const plan = await makePlan(idea);
      const id = await db.insertJob(idea, plan);
      // CEO review async — không block response; user sẽ thấy rating xuất hiện sau vài giây.
      db.appendSystemLog("prototyper", `Manual submit → ${id} "${idea.title}"`, "summary").catch(() => {});
      ceoReview(idea).then(async (r) => {
        if (r) {
          await db.setCeoReview(id, r.rating, JSON.stringify(r.critique));
          console.log(`[CEO] ${id}: ${r.rating}⭐`);
          await db.appendSystemLog("ceo", `${id}: ${r.rating}⭐`, "summary").catch(() => {});
          // Auto-approve nếu >= threshold.
          if (CONFIG.autoApproveMinRating > 0 && r.rating >= CONFIG.autoApproveMinRating) {
            await db.setStatus(id, "approved");
            console.log(`[auto-approve] ${id} → approved (${r.rating}⭐ >= ${CONFIG.autoApproveMinRating})`);
            await db.appendSystemLog("auto-approve", `${id} → approved (${r.rating}⭐ ≥ ${CONFIG.autoApproveMinRating})`, "summary").catch(() => {});
          }
        } else {
          console.log(`[CEO] ${id}: null (LLM fail hoặc mock mode)`);
          await db.appendSystemLog("ceo", `${id}: review failed`, "error").catch(() => {});
        }
      }).catch((e) => console.log(`[CEO] ${id}: ERROR ${e?.message ?? e}`));
      return Response.json({ ok: true, id, title: idea.title, slug: idea.slug });
    } catch (e: any) {
      return Response.json({ error: String(e?.message ?? e) }, { status: 500 });
    }
  }
  if (path === "/api/builder-choices") {
    return Response.json({ choices: BUILDER_CHOICES, default: BUILDER_DEFAULT });
  }
  // Model registry state — dashboard hiển thị cooldown.
  if (path === "/api/models") {
    await registry.refreshCooldowns();
    const cds = registry.getCooldowns();
    const models = Object.values(registry.MODELS).map((m) => ({
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
      deployed: all.filter((j) => j.status === "deployed").length,
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
    next.setUTCHours(h - 7 < 0 ? h - 7 + 24 : h - 7, m, 0, 0);  // MORNING_AT = giờ VN, VN = UTC+7
    if (next <= nowD) next.setUTCDate(next.getUTCDate() + 1);
    const nextSlotAt = (startedInWindow >= CONFIG.dailyBuildLimit && oldestInWindow)
      ? new Date(new Date(oldestInWindow).getTime() + CONFIG.buildWindowHours * 3600 * 1000).toISOString()
      : null;
    // Model cooldown snapshot
    await registry.refreshCooldowns();
    const cds = registry.getCooldowns();
    const cooldownCount = Object.keys(cds).filter((mm) => cds[mm] > new Date().toISOString()).length;
    const soonestCooldownReset = Object.values(cds).filter((v) => v > new Date().toISOString()).sort()[0] ?? null;

    return Response.json({
      startedInWindow, dailyLimit: CONFIG.dailyBuildLimit, buildWindowHours: CONFIG.buildWindowHours,
      counts, running,
      nextBatchAt: next.toISOString(),
      nextSlotAt,
      soonestRetryAt: soonestRetry,
      modelCooldowns: cooldownCount,
      soonestModelReset: soonestCooldownReset,
      morningAt: CONFIG.morningAt,
      pollIntervalMin: CONFIG.pollIntervalMin,
    });
  }
  // P1 — projects + issues API
  if (path === "/api/projects") return Response.json(await db.listProjects(100));
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
  if (path === "/" || path === "/index.html") return Response.redirect("/ideas", 302);
  if (path === "/ideas" || path === "/ideas/") {
    const r = await serveStatic(`${import.meta.dir}/../../web/ideas.html`);
    if (r) return r;
  }
  if (path === "/projects" || path.startsWith("/projects/")) {
    const r = await serveStatic(`${import.meta.dir}/../../web/projects.html`);
    if (r) return r;
  }

  // ─── HMAC action routes ──────────────────────────────────
  const [, action, id] = path.split("/");

  // Promote: demo-ready job → project + seeded issues (background)
  if (action === PROMOTE_ACTION && id) {
    if (!verify(id, PROMOTE_ACTION, url.searchParams.get("t") ?? "")) return page("❌ Token sai", 403);
    const r = await promoteJobToProject(id);
    if (!r) return page(`❌ Không thể promote ${id}: chỉ demo-ready mới promote được`, 400);
    return Response.json({ ok: true, project_id: r.projectId, issues: r.issues });
  }

  // Retry: reset job → approved, clear retry_after để poller pick ngay.
  // - failed | rejected | approved-waiting: requeue nguyên trạng plan.
  // - building | deploying (stuck): reset toàn bộ plan → pending (rebuild scratch).
  // - demo-ready + có failed sub-step: reset chỉ failed → pending (runBuild sẽ skip step đã done).
  if (action === RETRY_ACTION && id) {
    if (!verify(id, RETRY_ACTION, url.searchParams.get("t") ?? "")) return page("❌ Token sai", 403);
    const j = await db.getJob(id);
    if (!j) return page("❌ Không thấy job", 404);
    const hasFailedSteps = (j.plan?.steps ?? []).some((s: any) => s.status === "failed");
    const isDemoReadyWithFailures = j.status === "demo-ready" && hasFailedSteps;
    if (!["failed", "approved", "rejected", "building", "deploying"].includes(j.status) && !isDemoReadyWithFailures) {
      return page(`❌ Không retry được. Status hiện tại: ${j.status}`, 400);
    }
    if (["building", "deploying"].includes(j.status) && j.plan?.steps) {
      // Stuck job: rebuild từ đầu.
      const resetSteps = j.plan.steps.map((s: any) =>
        s.key === "spec" ? { ...s, status: "done" } : { ...s, status: "pending", note: undefined });
      await db.setPlan(id, { ...j.plan, steps: resetSteps });
    } else if (isDemoReadyWithFailures) {
      // Chỉ retry các step failed. runBuild skip step đã done nên implement/scaffold không rescaffold.
      const resetSteps = j.plan!.steps!.map((s: any) =>
        s.status === "failed" ? { ...s, status: "pending", note: undefined } : s);
      await db.setPlan(id, { ...j.plan, steps: resetSteps });
    }
    await db.requeueWithRetry(id, new Date(Date.now() - 1000).toISOString(), "manual retry");
    return Response.json({ ok: true, id, new_status: "approved" });
  }

  // Cancel: dừng build/deploy đang treo. Mark failed với note.
  // NOTE: không kill subprocess đang chạy — chỉ flip DB. Nếu process thực còn sống,
  // nó sẽ tự exit sau (không ảnh hưởng job khác) hoặc bị worker restart dọn.
  if (action === CANCEL_ACTION && id) {
    if (!verify(id, CANCEL_ACTION, url.searchParams.get("t") ?? "")) return page("❌ Token sai", 403);
    const j = await db.getJob(id);
    if (!j) return page("❌ Không thấy job", 404);
    if (!["building", "deploying", "approved"].includes(j.status)) {
      return page(`❌ Chỉ cancel được building/deploying/approved. Status hiện tại: ${j.status}`, 400);
    }
    await db.setResult(id, { ...(j.result ?? {}), error: "cancelled by user" } as any, "failed");
    return Response.json({ ok: true, id, new_status: "failed" });
  }

  // approve / reject / deploy — HMAC status change
  if (action in ACTIONS) {
    if (!verify(id, action, url.searchParams.get("t") ?? "")) return page("❌ Token sai", 403);
    if (!(await db.getJob(id))) return page("❌ Không thấy job", 404);
    // Approve: cho phép user pick builder model qua ?model=<key> (whitelist BUILDER_CHOICES).
    // Key GIỜ = model name trực tiếp (vd claude-sonnet-5). "auto" là sentinel = không set.
    if (action === "approve") {
      const modelKey = url.searchParams.get("model");
      if (modelKey && modelKey !== "auto") {
        if (!(modelKey in BUILDER_CHOICES)) {
          return page(`❌ Unknown builder model: ${modelKey}. Valid: ${Object.keys(BUILDER_CHOICES).join(", ")}`, 400);
        }
        await db.setBuilderModel(id, modelKey);
      }
      // modelKey === "auto" (hoặc không set) → skip setBuilderModel; registry tự route.
    }
    await db.setStatus(id, ACTIONS[action]);
    return page(`✅ <code>${id}</code> → <b>${ACTIONS[action]}</b>. <a href="/">← dashboard</a>`);
  }

  return page("❌ 404", 404);
}
