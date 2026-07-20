/**
 * projects/index.ts — Promote job "demo-ready" → project long-lived + seed issue backlog qua LLM.
 *
 * Flow:
 *   - promoteJobToProject(jobId): tạo project row (không seed issues — worker Mac có Claude auth sẽ seed sau).
 *   - seedEmptyProjects: worker poll pick project status=active + 0 issues → atomic claim → gọi LLM sinh issues.
 *   - seedProjectIssues: LLM (MODEL_PROTOTYPER) sinh 5-8 issues song ngữ EN + VI.
 *
 * Atomic claim (status active → seeding → active) tránh race giữa 2 poll process.
 */

import { CONFIG } from "../config";
import * as db from "../db";
import { callLLM } from "../llm";
import { log } from "../util/logger";
import type { Idea } from "../types";

// Sinh 5-8 issues khởi tạo từ idea brief. Dùng MODEL_PROTOTYPER (creative synthesis).
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
    const raw = await callLLM(CONFIG.modelPrototyper, prompt, { num_predict: 16384, timeoutMs: 180_000 });
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
export async function promoteJobToProject(jobId: string): Promise<{ projectId: string; issues: number } | null> {
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
    prod_domain: `${slug}.${CONFIG.deployDomain}`,
    staging_domain: `staging-${slug}.${CONFIG.deployDomain}`,
  });
  return { projectId, issues: 0 };  // worker sẽ seed sau
}

// Worker poll: pick project chưa có issue → seed via LLM. Atomic claim (status active→seeding)
// tránh race giữa 2 poll process (launchd worker + manual poll).
export async function seedEmptyProjects(): Promise<void> {
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
