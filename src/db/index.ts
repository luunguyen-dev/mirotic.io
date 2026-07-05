/**
 * db.ts — Kho ý tưởng dùng chung.
 *   - Có DATABASE_URL  → Postgres (Bun.sql built-in, zero-dep) — để web + orchestrator cùng truy cập.
 *   - Không có          → SQLite local (DATA_DIR/mirotic.db) cho dev nhanh.
 * Mọi hàm async, cùng một interface → đổi backend không ảnh hưởng phần còn lại.
 */

import { SQL } from "bun";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import type { Idea } from "../types";

export type JobStatus =
  | "proposed"          // Prototyper vừa gom
  | "approved"          // bạn duyệt trên web → chờ thực thi
  | "building"          // poller đã nhận, executor đang chạy
  | "demo-ready"        // đã build: docker chạy local + repo private + CI/CD sẵn → bạn test ở nhà
  | "deploy-requested"  // bạn bấm nút Deploy trên web (sau khi duyệt demo)
  | "deploying"
  | "deployed"
  | "rejected" | "failed" | "skipped";

export type Job = {
  id: string; created_at: string; status: string;
  idea: Idea; plan: any; result: any;
  reject_reason: string | null; started_at: string | null;
  error_detail: string | null;
  ceo_rating: number | null;
  ceo_critique: string | null;  // JSON blob {en, vi}
  builder_model: string | null;      // user pick trước Approve; null = auto
  builder_model_used: string | null; // model thực sự dùng (auto-resolved từ registry sau IMPLEMENT)
  retry_after: string | null;        // ISO ts; approved job bị skip đến khi qua mốc (rate-limit reset)
  total_cost_usd: number | null;     // tổng USD Claude CLI report từ mọi session (implement + review + cso + qa)
  total_turns: number | null;        // tổng số conversation turn từ mọi session
};

const SCHEMA = `CREATE TABLE IF NOT EXISTS jobs (
  id text primary key, created_at text, status text,
  idea_json text, plan_json text, result_json text,
  reject_reason text, started_at text )`;

const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);

function parse(r: any): Job {
  return {
    id: r.id, created_at: r.created_at, status: r.status,
    idea: r.idea_json ? JSON.parse(r.idea_json) : null,
    plan: r.plan_json ? JSON.parse(r.plan_json) : null,
    result: r.result_json ? JSON.parse(r.result_json) : null,
    reject_reason: r.reject_reason ?? null,
    started_at: r.started_at ?? null,
    error_detail: r.error_detail ?? null,
    ceo_rating: r.ceo_rating ?? null,
    ceo_critique: r.ceo_critique ?? null,
    builder_model: r.builder_model ?? null,
    builder_model_used: r.builder_model_used ?? null,
    retry_after: r.retry_after ?? null,
    total_cost_usd: r.total_cost_usd != null ? Number(r.total_cost_usd) : null,
    total_turns: r.total_turns != null ? Number(r.total_turns) : null,
  };
}

export type PoolItem = {
  id: string; created_at: string; title: string; pitch: string; why: string;
  source: string; url: string | null; type: string; score: number; promoted: boolean;
  title_vi?: string | null; pitch_vi?: string | null; why_vi?: string | null;
  title_en?: string | null; pitch_en?: string | null; why_en?: string | null;
  ceo_rating?: number | null; ceo_critique?: string | null;
};

export type LogEntry = { id: number; job_id: string; ts: string; level: string; line: string };
export type ModelCooldown = { model: string; cooldown_until: string; reason: string | null; updated_at: string };

// P1 — projects + issues
export type Project = {
  id: string; source_job_id: string | null;
  slug: string; title: string; title_vi: string | null; description: string | null;
  status: string;                 // active | paused | archived
  repo_url: string | null; prod_domain: string | null; staging_domain: string | null;
  created_at: string; updated_at: string;
};
export type IssueType = "feature" | "bug" | "chore" | "spike" | "adr";
export type IssueStatus = "backlog" | "ready" | "in_progress" | "review" | "shipped" | "dropped";
export type IssuePriority = "p0" | "p1" | "p2" | "p3";
export type Issue = {
  id: string; project_id: string; milestone_id: string | null;
  title: string; title_vi: string | null; description: string | null; description_vi: string | null;
  type: IssueType; status: IssueStatus; priority: IssuePriority;
  parent_issue_id: string | null;
  builder_model: string | null; ceo_rating: number | null; ceo_critique: string | null;
  branch_name: string | null; pr_url: string | null;
  created_at: string; updated_at: string;
};
export type NewIssue = Partial<Issue> & { project_id: string; title: string };

interface Backend {
  init(): Promise<void>;
  insertJob(idea: Idea, plan: any): Promise<string>;
  getJob(id: string): Promise<Job | null>;
  listJobs(limit: number): Promise<Array<{ id: string; status: string; created_at: string }>>;
  setStatus(id: string, status: JobStatus): Promise<void>;
  setResult(id: string, result: any, status: JobStatus): Promise<void>;
  setRejectReason(id: string, reason: string): Promise<void>;
  setCeoReview(id: string, rating: number, critique: string): Promise<void>;
  setPlan(id: string, plan: any): Promise<void>;
  setBuilderModel(id: string, model: string): Promise<void>;
  setBuilderModelUsed(id: string, model: string): Promise<void>;
  addJobCost(id: string, turns: number, costUsd: number): Promise<void>;
  requeueWithRetry(id: string, retryAfter: string, note: string): Promise<void>;   // reset status → approved, set retry_after
  // model cooldowns
  listCooldowns(): Promise<ModelCooldown[]>;
  setModelCooldown(model: string, cooldownUntil: string, reason: string): Promise<void>;
  clearModelCooldown(model: string): Promise<void>;
  countStartedToday(): Promise<number>;                        // legacy calendar-day gate
  countStartedRecent(hours: number): Promise<number>;          // rolling window (24h default)
  oldestStartedInWindow(hours: number): Promise<string | null>; // ISO ts của build cũ nhất trong window (để compute next slot)
  claimNextApproved(): Promise<Job | null>;        // approved → building (+started_at)
  claimNextDeployRequested(): Promise<Job | null>; // deploy-requested → deploying
  // idea_pool
  insertPoolItem(item: Omit<PoolItem, "created_at" | "promoted">): Promise<void>;
  listPool(limit: number): Promise<PoolItem[]>;
  markPoolPromoted(id: string): Promise<void>;
  // job_logs
  appendLog(jobId: string, line: string, level?: string): Promise<void>;
  getLogs(jobId: string, sinceId: number, limit: number): Promise<LogEntry[]>;
  getEvents(sinceId: number, limit: number): Promise<Array<LogEntry & { title: string | null; actor: string | null }>>;
  appendSystemLog(actor: string, line: string, level?: string): Promise<void>;
  // projects + issues (P1)
  createProject(p: Omit<Project, "created_at" | "updated_at">): Promise<void>;
  getProject(id: string): Promise<Project | null>;
  getProjectBySlug(slug: string): Promise<Project | null>;
  listProjects(limit: number): Promise<Project[]>;
  setProjectStatus(id: string, status: string): Promise<void>;
  claimProjectForSeed(id: string): Promise<boolean>;   // atomic swap active→seeding; false nếu đã ai claim
  createIssue(iss: NewIssue): Promise<string>;
  listIssues(projectId: string): Promise<Issue[]>;
  setIssueStatus(id: string, status: IssueStatus): Promise<void>;
  close(): Promise<void>;
}

const jobId = (idea: Idea) => `${today()}-${idea.slug}`;

// ----------------------------- Postgres -----------------------------
function pgBackend(url: string): Backend {
  const sql = new SQL(url);
  return {
    async init() {
      await sql.unsafe(SCHEMA);
      // Idempotent migrations (khớp infra/aws/schema.sql).
      await sql.unsafe(`
        ALTER TABLE jobs ADD COLUMN IF NOT EXISTS total_cost_usd DOUBLE PRECISION;
        ALTER TABLE jobs ADD COLUMN IF NOT EXISTS total_turns INTEGER;
        CREATE TABLE IF NOT EXISTS system_events (
          id     BIGSERIAL PRIMARY KEY,
          ts     TEXT NOT NULL,
          actor  TEXT NOT NULL,
          level  TEXT DEFAULT 'info',
          line   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS system_events_id_idx ON system_events (id DESC);
      `);
    },
    async insertJob(idea, plan) {
      const id = jobId(idea);
      const row = { id, created_at: now(), status: "proposed", idea_json: JSON.stringify(idea), plan_json: JSON.stringify(plan) };
      await sql`INSERT INTO jobs ${sql(row)} ON CONFLICT (id) DO UPDATE SET
        idea_json = EXCLUDED.idea_json, plan_json = EXCLUDED.plan_json, status = 'proposed'`;
      return id;
    },
    async getJob(id) { const r = await sql`SELECT * FROM jobs WHERE id = ${id}`; return r.length ? parse(r[0]) : null; },
    async listJobs(limit) { return await sql`SELECT id, status, created_at FROM jobs ORDER BY created_at DESC LIMIT ${limit}`; },
    async setStatus(id, status) { await sql`UPDATE jobs SET status = ${status} WHERE id = ${id}`; },
    async setResult(id, result, status) {
      const errorDetail = status === "failed" ? (result?.error ?? "unknown error") : null;
      await sql`UPDATE jobs SET result_json = ${JSON.stringify(result)}, status = ${status}, error_detail = ${errorDetail} WHERE id = ${id}`;
    },
    async setRejectReason(id, reason) { await sql`UPDATE jobs SET reject_reason = ${reason} WHERE id = ${id}`; },
    async setCeoReview(id, rating, critique) {
      await sql`UPDATE jobs SET ceo_rating = ${rating}, ceo_critique = ${critique} WHERE id = ${id}`;
    },
    async setPlan(id, plan) {
      await sql`UPDATE jobs SET plan_json = ${JSON.stringify(plan)} WHERE id = ${id}`;
    },
    async setBuilderModel(id, model) {
      await sql`UPDATE jobs SET builder_model = ${model} WHERE id = ${id}`;
    },
    async setBuilderModelUsed(id, model) {
      await sql`UPDATE jobs SET builder_model_used = ${model} WHERE id = ${id}`;
    },
    async addJobCost(id, turns, costUsd) {
      await sql`UPDATE jobs SET
        total_turns    = COALESCE(total_turns, 0) + ${turns},
        total_cost_usd = COALESCE(total_cost_usd, 0) + ${costUsd}
        WHERE id = ${id}`;
    },
    async requeueWithRetry(id, retryAfter, note) {
      await sql`UPDATE jobs SET status = 'approved', started_at = NULL,
        retry_after = ${retryAfter}, error_detail = ${note} WHERE id = ${id}`;
    },
    async listCooldowns() {
      return (await sql`SELECT model, cooldown_until, reason, updated_at FROM model_cooldowns
        WHERE cooldown_until > ${now()}`) as any;
    },
    async setModelCooldown(model, cooldownUntil, reason) {
      await sql`INSERT INTO model_cooldowns (model, cooldown_until, reason, updated_at)
        VALUES (${model}, ${cooldownUntil}, ${reason}, ${now()})
        ON CONFLICT (model) DO UPDATE SET cooldown_until = EXCLUDED.cooldown_until,
          reason = EXCLUDED.reason, updated_at = EXCLUDED.updated_at`;
    },
    async clearModelCooldown(model) {
      await sql`DELETE FROM model_cooldowns WHERE model = ${model}`;
    },
    async countStartedToday() {
      const r = await sql`SELECT count(*)::int AS n FROM jobs WHERE started_at IS NOT NULL AND left(started_at, 10) = ${today()}`;
      return r[0].n;
    },
    async countStartedRecent(hours) {
      const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      const r = await sql`SELECT count(*)::int AS n FROM jobs WHERE started_at IS NOT NULL AND started_at >= ${cutoff}`;
      return r[0].n;
    },
    async oldestStartedInWindow(hours) {
      const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      const r = await sql`SELECT MIN(started_at) AS oldest FROM jobs WHERE started_at IS NOT NULL AND started_at >= ${cutoff}`;
      return (r[0].oldest as string | null) ?? null;
    },
    async claimNextApproved() {
      const r = await sql`UPDATE jobs SET status = 'building', started_at = ${now()}
        WHERE id = (
          SELECT id FROM jobs
          WHERE status = 'approved'
            AND (retry_after IS NULL OR retry_after <= ${now()})
          ORDER BY created_at LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *`;
      return r.length ? parse(r[0]) : null;
    },
    async claimNextDeployRequested() {
      const r = await sql`UPDATE jobs SET status = 'deploying'
        WHERE id = (SELECT id FROM jobs WHERE status = 'deploy-requested' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING *`;
      return r.length ? parse(r[0]) : null;
    },
    async insertPoolItem(item) {
      const row = { ...item, created_at: now() };
      await sql`INSERT INTO idea_pool ${sql(row)} ON CONFLICT (id) DO UPDATE SET
        score = EXCLUDED.score, created_at = EXCLUDED.created_at`;
    },
    async listPool(limit) {
      const r = await sql`SELECT * FROM idea_pool WHERE promoted = FALSE ORDER BY score DESC LIMIT ${limit}`;
      return r as any;
    },
    async markPoolPromoted(id) { await sql`UPDATE idea_pool SET promoted = TRUE WHERE id = ${id}`; },
    async appendLog(jobId, line, level = "info") {
      await sql`INSERT INTO job_logs (job_id, ts, level, line) VALUES (${jobId}, ${now()}, ${level}, ${line})`;
    },
    async getLogs(jobId, sinceId, limit) {
      const r = await sql`SELECT id, job_id, ts, level, line FROM job_logs
        WHERE job_id = ${jobId} AND id > ${sinceId} ORDER BY id ASC LIMIT ${limit}`;
      return r as any;
    },
    async getEvents(sinceId, limit) {
      // Union job_logs (job-scoped) + system_events (batch-level actor logs).
      // Ordering: ts DESC (id không so được giữa 2 bảng có sequence riêng).
      const [jobRows, sysRows] = await Promise.all([
        sql`SELECT l.id, l.job_id, l.ts, l.level, l.line,
          (jobs.idea_json::json->>'title') AS title, NULL::text AS actor
          FROM job_logs l LEFT JOIN jobs ON jobs.id = l.job_id
          WHERE l.level IN ('summary', 'error')
          ORDER BY l.id DESC LIMIT ${limit}`,
        sql`SELECT id, NULL::text AS job_id, ts, level, line, NULL::text AS title, actor
          FROM system_events
          WHERE level IN ('summary', 'error', 'info')
          ORDER BY id DESC LIMIT ${limit}`,
      ]);
      const merged = [...jobRows, ...sysRows]
        .sort((a: any, b: any) => (b.ts > a.ts ? 1 : b.ts < a.ts ? -1 : 0))
        .slice(0, limit);
      return merged as any;
    },
    async appendSystemLog(actor, line, level = "info") {
      await sql`INSERT INTO system_events (ts, actor, level, line) VALUES (${now()}, ${actor}, ${level}, ${line})`;
    },
    async createProject(p) {
      const row = { ...p, created_at: now(), updated_at: now() };
      await sql`INSERT INTO projects ${sql(row)}`;
    },
    async getProject(id) {
      const r = await sql`SELECT * FROM projects WHERE id = ${id}`;
      return r.length ? (r[0] as any) : null;
    },
    async getProjectBySlug(slug) {
      const r = await sql`SELECT * FROM projects WHERE slug = ${slug}`;
      return r.length ? (r[0] as any) : null;
    },
    async listProjects(limit) {
      const r = await sql`SELECT * FROM projects WHERE status IN ('active', 'seeding') ORDER BY updated_at DESC LIMIT ${limit}`;
      return r as any;
    },
    async setProjectStatus(id, status) {
      await sql`UPDATE projects SET status = ${status}, updated_at = ${now()} WHERE id = ${id}`;
    },
    async claimProjectForSeed(id) {
      const r = await sql`UPDATE projects SET status = 'seeding', updated_at = ${now()}
        WHERE id = ${id} AND status = 'active' RETURNING id`;
      return r.length > 0;
    },
    async createIssue(iss) {
      const id = iss.id ?? `${iss.project_id}-${(iss.title ?? "issue").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}-${Math.random().toString(36).slice(2, 6)}`;
      const row: any = {
        id, project_id: iss.project_id, milestone_id: iss.milestone_id ?? null,
        title: iss.title, title_vi: iss.title_vi ?? null,
        description: iss.description ?? null, description_vi: iss.description_vi ?? null,
        type: iss.type ?? "feature", status: iss.status ?? "backlog", priority: iss.priority ?? "p2",
        parent_issue_id: iss.parent_issue_id ?? null,
        builder_model: iss.builder_model ?? null, ceo_rating: iss.ceo_rating ?? null,
        ceo_critique: iss.ceo_critique ?? null,
        branch_name: iss.branch_name ?? null, pr_url: iss.pr_url ?? null,
        created_at: now(), updated_at: now(),
      };
      await sql`INSERT INTO issues ${sql(row)}`;
      return id;
    },
    async listIssues(projectId) {
      const r = await sql`SELECT * FROM issues WHERE project_id = ${projectId} ORDER BY priority ASC, created_at DESC`;
      return r as any;
    },
    async setIssueStatus(id, status) {
      await sql`UPDATE issues SET status = ${status}, updated_at = ${now()} WHERE id = ${id}`;
    },
    async close() { await sql.end(); },
  };
}

// ------------------------------ SQLite ------------------------------
function sqliteBackend(): Backend {
  const dir = process.env.DATA_DIR ?? "./data";
  mkdirSync(dir, { recursive: true });
  const db = new Database(`${dir}/mirotic.db`);
  return {
    async init() {
      db.run(SCHEMA);
      try { db.run(`ALTER TABLE jobs ADD COLUMN error_detail TEXT`); } catch {} // idempotent
    },
    async insertJob(idea, plan) {
      const id = jobId(idea);
      db.run(`INSERT OR REPLACE INTO jobs (id, created_at, status, idea_json, plan_json) VALUES (?,?,?,?,?)`,
        [id, now(), "proposed", JSON.stringify(idea), JSON.stringify(plan)]);
      return id;
    },
    async getJob(id) { const r = db.query(`SELECT * FROM jobs WHERE id = ?`).get(id); return r ? parse(r) : null; },
    async listJobs(limit) { return db.query(`SELECT id, status, created_at FROM jobs ORDER BY created_at DESC LIMIT ?`).all(limit) as any; },
    async setStatus(id, status) { db.run(`UPDATE jobs SET status = ? WHERE id = ?`, [status, id]); },
    async setResult(id, result, status) {
      const errorDetail = status === "failed" ? (result?.error ?? "unknown error") : null;
      db.run(`UPDATE jobs SET result_json = ?, status = ?, error_detail = ? WHERE id = ?`, [JSON.stringify(result), status, errorDetail, id]);
    },
    async setRejectReason(id, reason) { db.run(`UPDATE jobs SET reject_reason = ? WHERE id = ?`, [reason, id]); },
    async setCeoReview(id, rating, critique) {
      try { db.run(`ALTER TABLE jobs ADD COLUMN ceo_rating INTEGER`); } catch {}
      try { db.run(`ALTER TABLE jobs ADD COLUMN ceo_critique TEXT`); } catch {}
      db.run(`UPDATE jobs SET ceo_rating = ?, ceo_critique = ? WHERE id = ?`, [rating, critique, id]);
    },
    async setPlan(id, plan) { db.run(`UPDATE jobs SET plan_json = ? WHERE id = ?`, [JSON.stringify(plan), id]); },
    async setBuilderModel(id, model) {
      try { db.run(`ALTER TABLE jobs ADD COLUMN builder_model TEXT`); } catch {}
      db.run(`UPDATE jobs SET builder_model = ? WHERE id = ?`, [model, id]);
    },
    async setBuilderModelUsed(id, model) {
      try { db.run(`ALTER TABLE jobs ADD COLUMN builder_model_used TEXT`); } catch {}
      db.run(`UPDATE jobs SET builder_model_used = ? WHERE id = ?`, [model, id]);
    },
    async addJobCost(id, turns, costUsd) {
      try { db.run(`ALTER TABLE jobs ADD COLUMN total_cost_usd REAL`); } catch {}
      try { db.run(`ALTER TABLE jobs ADD COLUMN total_turns INTEGER`); } catch {}
      db.run(`UPDATE jobs SET
        total_turns    = COALESCE(total_turns, 0) + ?,
        total_cost_usd = COALESCE(total_cost_usd, 0) + ?
        WHERE id = ?`, [turns, costUsd, id]);
    },
    async requeueWithRetry(id, retryAfter, note) {
      try { db.run(`ALTER TABLE jobs ADD COLUMN retry_after TEXT`); } catch {}
      db.run(`UPDATE jobs SET status='approved', started_at=NULL, retry_after=?, error_detail=? WHERE id=?`,
        [retryAfter, note, id]);
    },
    async listCooldowns() { return []; },
    async setModelCooldown() {},
    async clearModelCooldown() {},
    async countStartedToday() {
      const r = db.query(`SELECT count(*) AS n FROM jobs WHERE started_at IS NOT NULL AND substr(started_at,1,10) = ?`).get(today()) as any;
      return r.n;
    },
    async countStartedRecent(hours) {
      const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      const r = db.query(`SELECT count(*) AS n FROM jobs WHERE started_at IS NOT NULL AND started_at >= ?`).get(cutoff) as any;
      return r.n;
    },
    async oldestStartedInWindow(hours) {
      const cutoff = new Date(Date.now() - hours * 3600 * 1000).toISOString();
      const r = db.query(`SELECT MIN(started_at) AS oldest FROM jobs WHERE started_at IS NOT NULL AND started_at >= ?`).get(cutoff) as any;
      return r?.oldest ?? null;
    },
    async claimNextApproved() {
      const r = db.query(`SELECT * FROM jobs WHERE status = 'approved' ORDER BY created_at LIMIT 1`).get() as any;
      if (!r) return null;
      const t = now();
      db.run(`UPDATE jobs SET status = 'building', started_at = ? WHERE id = ?`, [t, r.id]);
      r.status = "building"; r.started_at = t;
      return parse(r);
    },
    async claimNextDeployRequested() {
      const r = db.query(`SELECT * FROM jobs WHERE status = 'deploy-requested' ORDER BY created_at LIMIT 1`).get() as any;
      if (!r) return null;
      db.run(`UPDATE jobs SET status = 'deploying' WHERE id = ?`, [r.id]);
      r.status = "deploying";
      return parse(r);
    },
    async insertPoolItem(item) {
      db.run(`CREATE TABLE IF NOT EXISTS idea_pool (id text primary key, created_at text, title text,
        pitch text, why text, source text, url text, type text, score real, promoted integer default 0)`);
      db.run(`INSERT OR REPLACE INTO idea_pool (id, created_at, title, pitch, why, source, url, type, score, promoted)
        VALUES (?,?,?,?,?,?,?,?,?,COALESCE((SELECT promoted FROM idea_pool WHERE id = ?), 0))`,
        [item.id, now(), item.title, item.pitch, item.why, item.source, item.url, item.type, item.score, item.id]);
    },
    async listPool(limit) {
      return db.query(`SELECT * FROM idea_pool WHERE promoted = 0 ORDER BY score DESC LIMIT ?`).all(limit) as any;
    },
    async markPoolPromoted(id) { db.run(`UPDATE idea_pool SET promoted = 1 WHERE id = ?`, [id]); },
    async appendLog(jobId, line, level = "info") {
      db.run(`CREATE TABLE IF NOT EXISTS job_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT, ts TEXT, level TEXT, line TEXT)`);
      db.run(`INSERT INTO job_logs (job_id, ts, level, line) VALUES (?,?,?,?)`, [jobId, now(), level, line]);
    },
    async getLogs(jobId, sinceId, limit) {
      return db.query(`SELECT id, job_id, ts, level, line FROM job_logs
        WHERE job_id = ? AND id > ? ORDER BY id ASC LIMIT ?`).all(jobId, sinceId, limit) as any;
    },
    async getEvents(sinceId, limit) {
      try { db.run(`CREATE TABLE IF NOT EXISTS system_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, actor TEXT, level TEXT, line TEXT)`); } catch {}
      const jobRows = db.query(`SELECT l.id, l.job_id, l.ts, l.level, l.line,
        json_extract(jobs.idea_json, '$.title') AS title, NULL AS actor
        FROM job_logs l LEFT JOIN jobs ON jobs.id = l.job_id
        WHERE l.level IN ('summary','error')
        ORDER BY l.id DESC LIMIT ?`).all(limit) as any[];
      const sysRows = db.query(`SELECT id, NULL AS job_id, ts, level, line, NULL AS title, actor
        FROM system_events
        WHERE level IN ('summary','error','info')
        ORDER BY id DESC LIMIT ?`).all(limit) as any[];
      return [...jobRows, ...sysRows].sort((a, b) => (b.ts > a.ts ? 1 : b.ts < a.ts ? -1 : 0)).slice(0, limit);
    },
    async appendSystemLog(actor, line, level = "info") {
      try { db.run(`CREATE TABLE IF NOT EXISTS system_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, actor TEXT, level TEXT, line TEXT)`); } catch {}
      db.run(`INSERT INTO system_events (ts, actor, level, line) VALUES (?,?,?,?)`, [now(), actor, level, line]);
    },
    async createProject() { throw new Error("projects not supported in SQLite backend"); },
    async getProject() { return null; },
    async getProjectBySlug() { return null; },
    async listProjects() { return []; },
    async createIssue() { throw new Error("issues not supported in SQLite backend"); },
    async listIssues() { return []; },
    async setIssueStatus() { throw new Error("issues not supported in SQLite backend"); },
    async setProjectStatus() { throw new Error("projects not supported in SQLite backend"); },
    async claimProjectForSeed() { return false; },
    async close() { db.close(); },
  };
}

// ----------------------------- Facade -------------------------------
let backend: Backend;

export async function initDb(): Promise<void> {
  const url = process.env.DATABASE_URL;
  backend = url ? pgBackend(url) : sqliteBackend();
  await backend.init();
  console.log(`🗄️  DB: ${url ? "Postgres" : `SQLite (${process.env.DATA_DIR ?? "./data"}/mirotic.db)`}`);
}

export const insertJob = (idea: Idea, plan: any) => backend.insertJob(idea, plan);
export const getJob = (id: string) => backend.getJob(id);
export const listJobs = (limit = 50) => backend.listJobs(limit);
export const setStatus = (id: string, status: JobStatus) => backend.setStatus(id, status);
export const setResult = (id: string, result: any, status: JobStatus) => backend.setResult(id, result, status);
export const setRejectReason = (id: string, reason: string) => backend.setRejectReason(id, reason);
export const setCeoReview = (id: string, rating: number, critique: string) => backend.setCeoReview(id, rating, critique);
export const setPlan = (id: string, plan: any) => backend.setPlan(id, plan);
export const setBuilderModel = (id: string, model: string) => backend.setBuilderModel(id, model);
export const setBuilderModelUsed = (id: string, model: string) => backend.setBuilderModelUsed(id, model);
export const addJobCost = (id: string, turns: number, costUsd: number) => backend.addJobCost(id, turns, costUsd);
export const requeueWithRetry = (id: string, retryAfter: string, note: string) => backend.requeueWithRetry(id, retryAfter, note);
export const listCooldowns = () => backend.listCooldowns();
export const setModelCooldown = (m: string, until: string, reason: string) => backend.setModelCooldown(m, until, reason);
export const clearModelCooldown = (m: string) => backend.clearModelCooldown(m);
export const countStartedToday = () => backend.countStartedToday();
export const countStartedRecent = (hours: number) => backend.countStartedRecent(hours);
export const oldestStartedInWindow = (hours: number) => backend.oldestStartedInWindow(hours);
export const claimNextApproved = () => backend.claimNextApproved();
export const claimNextDeployRequested = () => backend.claimNextDeployRequested();
export const insertPoolItem = (item: Omit<PoolItem, "created_at" | "promoted">) => backend.insertPoolItem(item);
export const listPool = (limit = 50) => backend.listPool(limit);
export const markPoolPromoted = (id: string) => backend.markPoolPromoted(id);
export const appendLog = (jobId: string, line: string, level = "info") => backend.appendLog(jobId, line, level);
export const getLogs = (jobId: string, sinceId = 0, limit = 500) => backend.getLogs(jobId, sinceId, limit);
export const getEvents = (sinceId = 0, limit = 100) => backend.getEvents(sinceId, limit);
export const appendSystemLog = (actor: string, line: string, level = "info") => backend.appendSystemLog(actor, line, level);
// P1 — projects + issues
export const createProject = (p: Omit<Project, "created_at" | "updated_at">) => backend.createProject(p);
export const getProject = (id: string) => backend.getProject(id);
export const getProjectBySlug = (slug: string) => backend.getProjectBySlug(slug);
export const listProjects = (limit = 100) => backend.listProjects(limit);
export const createIssue = (iss: NewIssue) => backend.createIssue(iss);
export const listIssues = (projectId: string) => backend.listIssues(projectId);
export const setIssueStatus = (id: string, status: IssueStatus) => backend.setIssueStatus(id, status);
export const setProjectStatus = (id: string, status: string) => backend.setProjectStatus(id, status);
export const claimProjectForSeed = (id: string) => backend.claimProjectForSeed(id);
export const closeDb = () => backend.close();
