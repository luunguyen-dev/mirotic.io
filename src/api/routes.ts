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
        result: full.result,
        signs: jobSigns(full.id),
      } : null;
    }));
    return Response.json(detailed.filter(Boolean));
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
