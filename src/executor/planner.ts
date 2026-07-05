/**
 * planner.ts — Plan checklist + refine plan qua text tier LLM.
 *   - BASE_STEPS: milestone track chuẩn cho mọi build
 *   - makePlan: base Plan sinh khi idea insert (không LLM)
 *   - generateDetailedPlan: refine plan qua text tier (Planner role)
 *   - updatePlanStep: mark checklist step done/failed
 */

import { CONFIG } from "../config";
import * as db from "../db";
import { jLog } from "../util/logger";
import { callTextWithFallback } from "./ceo";
import type { Idea, Plan, PlanStep, ProjectType } from "../types";

export const STACK_BY_TYPE: Record<ProjectType, string> = {
  "web-frontend": "Vite + React + TypeScript + Tailwind (no backend)",
  "full-stack": "Next.js + Supabase (Postgres + auth)",
  cli: "Bun + TypeScript (single binary)",
  "browser-extension": "Manifest V3 + TypeScript + Vite",
};

// Base checklist: các milestone Builder + Deployer track (coarse).
export const BASE_STEPS: PlanStep[] = [
  { key: "spec",      label_en: "Spec approved",                       label_vi: "Đã duyệt spec",                    status: "done" },
  { key: "scaffold",  label_en: "Scaffold project",                    label_vi: "Scaffold project",                 status: "pending" },
  { key: "implement", label_en: "Implement core feature",              label_vi: "Implement core",                   status: "pending" },
  { key: "artifacts", label_en: "Dockerfile + compose + ship.sh",      label_vi: "Dockerfile + compose + ship.sh",   status: "pending" },
  { key: "github",    label_en: "Private GitHub repo pushed",          label_vi: "Repo private đã push",             status: "pending" },
  { key: "review",    label_en: "/review pass",                        label_vi: "/review pass",                     status: "pending" },
  { key: "cso",       label_en: "/cso security audit",                 label_vi: "/cso security audit",              status: "pending" },
  { key: "qa",        label_en: "/qa smoke test",                      label_vi: "/qa smoke test",                   status: "pending" },
  { key: "local",     label_en: "docker compose up local",             label_vi: "docker compose up local",          status: "pending" },
  { key: "deploy",    label_en: "Deploy AWS + Caddy live",             label_vi: "Deploy AWS + Caddy live",          status: "pending" },
];

// Base plan sinh khi idea insert. Không gọi LLM.
// KÈM steps để checklist hiển thị từ trạng thái proposed, không cần chờ runBuild sinh detailed plan.
export async function makePlan(idea: Idea): Promise<Plan> {
  return {
    problem: idea.why,
    tenStar: `Phiên bản 10 sao: ${idea.title} mượt tới mức người dùng không nghĩ về nó.`,
    scopeCut: "MVP 1 ngày: chỉ luồng chính.",
    stack: STACK_BY_TYPE[idea.type],
    buildSteps: ["Scaffold + tooling", "Core feature (happy path)", "Empty/error states", "Polish"],
    testPlan: [idea.type === "cli" ? "Unit + CLI smoke" : "Browser test (/qa)", "Edge cases", "Regression"],
    tasteDecisions: [`Stack: ${STACK_BY_TYPE[idea.type]} — OK?`, "Scope MVP — OK?"],
    steps: JSON.parse(JSON.stringify(BASE_STEPS)) as PlanStep[],
  };
}

// Refine plan chi tiết khi Approve — 1 turn text LLM qua Planner role.
export async function generateDetailedPlan(idea: Idea, jobId: string): Promise<Plan> {
  const stack = STACK_BY_TYPE[idea.type];
  const base: Plan = {
    problem: idea.why_en ?? idea.why,
    tenStar: `10-star: ${idea.title_en ?? idea.title} — smooth enough users don't think about it.`,
    scopeCut: `MVP demo trong ${idea.demo_hours ?? "1 ngày"}: happy path only.`,
    stack,
    buildSteps: (idea.features_en ?? []).length ? idea.features_en! : ["Scaffold", "Core feature", "Empty/error states", "Polish"],
    testPlan: [idea.type === "cli" ? "Unit + CLI smoke" : "Browser test (/qa)", "Edge cases", "Regression"],
    tasteDecisions: [`Stack: ${stack}`, "Scope MVP"],
    steps: JSON.parse(JSON.stringify(BASE_STEPS)) as PlanStep[],
  };

  if (CONFIG.useRealClaude) {
    try {
      const prompt = `Bạn có gstack. Refine plan build 1-day MVP cho idea:

Title: ${idea.title_en ?? idea.title}
Pitch: ${idea.pitch_en ?? idea.pitch}
Features (đề xuất): ${(idea.features_en ?? []).join("; ")}
Target user: ${idea.target_user_en ?? "—"}
Demo hours: ${idea.demo_hours ?? "?"}
Stack: ${stack}

Trả JSON DUY NHẤT không markdown:
{"scope_cut":"1 câu rõ MVP giới hạn","build_steps":["step 1","step 2","step 3","step 4","step 5"],"taste_decisions":["decision 1","decision 2","decision 3"],"test_plan":["test 1","test 2","test 3"]}`;
      const { model: planModel, output: raw } = await callTextWithFallback("planner", prompt, { timeoutMs: 60_000 });
      jLog(jobId, `[plan] refined via ${planModel}`, "info");
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        const p = JSON.parse(m[0]);
        if (p.scope_cut) base.scopeCut = String(p.scope_cut);
        if (Array.isArray(p.build_steps)) base.buildSteps = p.build_steps.slice(0, 8).map(String);
        if (Array.isArray(p.taste_decisions)) base.tasteDecisions = p.taste_decisions.slice(0, 6).map(String);
        if (Array.isArray(p.test_plan)) base.testPlan = p.test_plan.slice(0, 6).map(String);
      }
    } catch (e: any) {
      jLog(jobId, `[plan] refinement fail: ${e?.message ?? e} — giữ plan base`, "error");
    }
  }
  return base;
}

// Update 1 step status trong plan_json của job. Log kèm.
export async function updatePlanStep(jobId: string, stepKey: string, status: PlanStep["status"], note?: string): Promise<void> {
  const job = await db.getJob(jobId);
  if (!job?.plan?.steps) return;
  const step = job.plan.steps.find((s: PlanStep) => s.key === stepKey);
  if (!step) return;
  step.status = status;
  if (note) step.note = note.slice(0, 240);
  await db.setPlan(jobId, job.plan);
  jLog(jobId, `[plan] ${stepKey} → ${status}${note ? ` (${note.slice(0, 80)})` : ""}`, "summary");
}
