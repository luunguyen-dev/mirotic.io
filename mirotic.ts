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
import type { Idea, ProjectType, ScoredIdea } from "./prototyper";
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
  dailyBuildLimit: Number(env("DAILY_BUILD_LIMIT", "3")),
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
async function verifyBuildArtifacts(cwd: string): Promise<string[]> {
  const { statSync } = await import("node:fs");
  const missing: string[] = [];
  for (const f of ["Dockerfile", "docker-compose.yml", "ship.sh", "README.md"]) {
    try { statSync(`${cwd}/${f}`); } catch { missing.push(f); }
  }
  if (missing.length === 0) {
    try {
      const proc = Bun.spawn(["docker", "compose", "config", "--quiet"], { cwd, stdout: "pipe", stderr: "pipe" });
      await proc.exited;
      if (proc.exitCode !== 0) missing.push("docker-compose.yml (invalid: `docker compose config` fail)");
    } catch (e: any) { missing.push(`compose check err: ${e?.message}`); }
  }
  return missing;
}

import { callLLM, isGpt } from "./llm";

// Reasoning nhẹ (CEO review, plan refinement) — 1-turn text, route theo model prefix
// (claude-* → Claude CLI, gpt-* → Codex CLI, gemini-* → Google GenAI REST).
// Retry 2 lần với backoff 2s + 4s để chịu transient rate-limit / CLI hiccup.
async function callClaudeText(
  prompt: string,
  opts: { model?: string; timeoutMs?: number; retries?: number } = {},
): Promise<string> {
  if (!CONFIG.useRealClaude) return "";
  const model = opts.model ?? CONFIG.modelBuilder;
  const retries = opts.retries ?? 2;
  let lastErr: any;
  for (let i = 0; i <= retries; i++) {
    try {
      return await callLLM(model, prompt, { timeoutMs: opts.timeoutMs });
    } catch (e: any) {
      lastErr = e;
      if (i < retries) await new Promise((r) => setTimeout(r, (i + 1) * 2000));
    }
  }
  throw lastErr;
}

// Base checklist: các milestone Builder + Deployer track (coarse).
const BASE_STEPS: PlanStep[] = [
  { key: "spec",      label_en: "Spec approved",                       label_vi: "Đã duyệt spec",                    status: "done" },
  { key: "scaffold",  label_en: "Scaffold project",                    label_vi: "Scaffold project",                 status: "pending" },
  { key: "implement", label_en: "Implement core feature (Sonnet)",     label_vi: "Implement core (Sonnet)",          status: "pending" },
  { key: "artifacts", label_en: "Dockerfile + compose + ship.sh",      label_vi: "Dockerfile + compose + ship.sh",   status: "pending" },
  { key: "github",    label_en: "Private GitHub repo pushed",          label_vi: "Repo private đã push",             status: "pending" },
  { key: "review",    label_en: "/review pass (Haiku)",                label_vi: "/review pass (Haiku)",             status: "pending" },
  { key: "cso",       label_en: "/cso security audit (Sonnet)",        label_vi: "/cso security audit (Sonnet)",     status: "pending" },
  { key: "qa",        label_en: "/qa smoke test (Haiku)",              label_vi: "/qa smoke test (Haiku)",           status: "pending" },
  { key: "local",     label_en: "docker compose up local",             label_vi: "docker compose up local",          status: "pending" },
  { key: "deploy",    label_en: "Deploy AWS + Caddy live",             label_vi: "Deploy AWS + Caddy live",          status: "pending" },
];

async function generateDetailedPlan(idea: Idea, jobId: string): Promise<Plan> {
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

  // Nếu Claude bật + gstack có, xin refinement: 1 turn nhẹ chọn scope + task list riêng cho idea.
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
      const raw = await callClaudeText(prompt, { model: CONFIG.modelPlanner, timeoutMs: 60_000 });
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        const p = JSON.parse(m[0]);
        if (p.scope_cut) base.scopeCut = String(p.scope_cut);
        if (Array.isArray(p.build_steps)) base.buildSteps = p.build_steps.slice(0, 8).map(String);
        if (Array.isArray(p.taste_decisions)) base.tasteDecisions = p.taste_decisions.slice(0, 6).map(String);
        if (Array.isArray(p.test_plan)) base.testPlan = p.test_plan.slice(0, 6).map(String);
      }
    } catch (e: any) {
      jLog(jobId, `[plan] Claude refinement fail: ${e?.message ?? e} — giữ plan base`, "error");
    }
  }
  return base;
}

// Update 1 step status trong plan_json của job. Log kèm.
async function updatePlanStep(jobId: string, stepKey: string, status: PlanStep["status"], note?: string) {
  const job = await db.getJob(jobId);
  if (!job?.plan?.steps) return;
  const step = job.plan.steps.find((s: PlanStep) => s.key === stepKey);
  if (!step) return;
  step.status = status;
  if (note) step.note = note.slice(0, 240);
  await db.setPlan(jobId, job.plan);
  jLog(jobId, `[plan] ${stepKey} → ${status}${note ? ` (${note.slice(0, 80)})` : ""}`, "summary");
}

async function ceoReview(idea: Idea): Promise<{ rating: number; critique: { en: string; vi: string } } | null> {
  if (!CONFIG.useRealClaude) return null;
  const prompt = `Bạn là CEO review 1 ý tưởng sản phẩm cho founder solo. Founder có thời gian ~1 ngày cho MVP.

IDEA:
- Title: ${idea.title_en ?? idea.title}
- Pitch: ${idea.pitch_en ?? idea.pitch}
- Target user: ${idea.target_user_en ?? "—"}
- Features: ${(idea.features_en ?? []).join("; ") || "—"}
- Why now: ${idea.why_now_en ?? "—"}
- Risk: ${idea.risk_en ?? "—"}
- Demo hours ước lượng: ${idea.demo_hours ?? "?"}
- Source: ${idea.source}

Rubric rating 1-5 (thang sao):
- 5 = high-value, PMF signal rõ, scope tight, low risk, khác biệt rõ với existing
- 4 = tốt, đáng build 1 ngày, vài caveats nhỏ
- 3 = trung bình, có value nhưng thị trường đông / weak differentiation
- 2 = yếu, low pull, thị trường không rõ
- 1 = không nên build, misaligned với niche hoặc chỉ là stunt

Chấm PHẢN BIỆN: nêu weakness thẳng, đừng nịnh. Nếu scope > 1 ngày → giảm rating.

Trả JSON DUY NHẤT, không markdown, không giải thích ngoài:
{"rating": <1..5>, "critique_en": "3-4 câu strengths + weaknesses + verdict", "critique_vi": "3-4 câu tiếng Việt"}`;
  try {
    const raw = await callClaudeText(prompt, { model: CONFIG.modelCeo, timeoutMs: 60_000 });
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    return {
      rating: Math.max(1, Math.min(5, Math.round(Number(parsed.rating) || 3))),
      critique: { en: String(parsed.critique_en ?? ""), vi: String(parsed.critique_vi ?? "") },
    };
  } catch (e: any) {
    log(`   (CEO review fail: ${e?.message ?? e})`);
    return null;
  }
}

/** Codex CLI agentic session — cho MODEL=gpt-*. Sandbox workspace-write, approval=never.
 *  Streams JSONL events → job_logs qua callback đơn giản. */
async function callCodexAgent(prompt: string, cwd: string, jobId: string | undefined, model: string): Promise<string> {
  const outFile = `/tmp/codex-agent-${jobId ?? Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
  const proc = Bun.spawn(
    [
      "codex", "exec", "-m", model,
      "-s", "workspace-write", "-C", cwd, "--skip-git-repo-check",
      "-c", 'approval_policy="never"',
      "--json", "--output-last-message", outFile,
      prompt,
    ],
    { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env } }
  );
  const streamRead = async (stream: ReadableStream<Uint8Array>, isStderr: boolean) => {
    const reader = stream.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop() ?? "";
      for (const l of lines) {
        if (!l.trim()) continue;
        (isStderr ? process.stderr : process.stdout).write(l + "\n");
        if (jobId) db.appendLog(jobId, `[codex] ${l.slice(0, 400)}`, isStderr ? "error" : "tool").catch(() => {});
      }
    }
  };
  await Promise.all([streamRead(proc.stdout as any, false), streamRead(proc.stderr as any, true)]);
  await proc.exited;
  const final = await Bun.file(outFile).text().catch(() => "");
  try { await Bun.$`rm -f ${outFile}`.quiet(); } catch {}
  if (proc.exitCode !== 0) throw new Error(`codex exited ${proc.exitCode}`);
  return final.trim() || `exited=${proc.exitCode}`;
}

async function callClaudeCode(
  prompt: string, cwd: string, jobId?: string,
  opts: { model?: string; allowedTools?: string } = {}
): Promise<string> {
  if (!CONFIG.useRealClaude) return "[mock-claude-output]";
  const model = opts.model ?? CONFIG.modelBuilder;
  // Route GPT-* → Codex CLI (agentic, sandbox default). Claude CLI cho claude-* + fallback.
  if (isGpt(model)) return callCodexAgent(prompt, cwd, jobId, model);
  const proc = Bun.spawn(
    [
      "claude", "-p", prompt,
      "--model", model,
      "--allowed-tools", opts.allowedTools ?? "Bash,Edit,Write,Read,Glob,Grep,WebSearch,WebFetch,Skill,Task",
      "--output-format", "stream-json", "--verbose",
    ],
    { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env } }
  );

  // Stream + parse NDJSON: pass-through console + append summary to DB per-job.
  const streamParse = async (stream: ReadableStream<Uint8Array>, isStderr = false) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        (isStderr ? process.stderr : process.stdout).write(line + "\n");
        if (jobId) await parseClaudeEventToLog(line, jobId).catch(() => {});
      }
    }
  };
  const readers = [streamParse(proc.stdout as any), streamParse(proc.stderr as any, true)];
  await Promise.all(readers);
  await proc.exited;
  if (proc.exitCode !== 0) throw new Error(`claude exited with code ${proc.exitCode}`);
  return `exited=${proc.exitCode}`;
}

async function parseClaudeEventToLog(line: string, jobId: string) {
  let ev: any;
  try { ev = JSON.parse(line); } catch { return; }
  if (ev.type === "assistant" && ev.message?.content) {
    for (const c of ev.message.content) {
      if (c.type === "text" && c.text?.trim()) {
        await db.appendLog(jobId, c.text.trim().slice(0, 500), "claude");
      } else if (c.type === "tool_use") {
        const args = JSON.stringify(c.input ?? {}).slice(0, 120);
        await db.appendLog(jobId, `🔧 ${c.name}(${args})`, "tool");
      }
    }
  } else if (ev.type === "user" && ev.message?.content) {
    for (const c of ev.message.content) {
      if (c.type === "tool_result") {
        const text = typeof c.content === "string" ? c.content : JSON.stringify(c.content);
        const clean = text.replace(/\s+/g, " ").slice(0, 200);
        await db.appendLog(jobId, `↩ ${clean}`, "result");
      }
    }
  } else if (ev.type === "result") {
    const cost = ev.total_cost_usd ? `$${ev.total_cost_usd.toFixed(4)}` : "";
    await db.appendLog(jobId, `${ev.is_error ? "❌" : "✓"} ${ev.num_turns ?? 0} turns · ${cost}`.trim(), "summary");
  }
}
async function sendEmail(subject: string, html: string, tag: string) {
  const file = `${CONFIG.outbox}/${Date.now()}-${tag}.html`;
  writeFileSync(file, html);
  if (!CONFIG.resendApiKey || !CONFIG.emailTo) return log(`   📧 (mock) "${subject}" → ${file}`);
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${CONFIG.resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: CONFIG.emailFrom, to: CONFIG.emailTo, subject, html }),
    });
    log(r.ok ? `   📧 gửi → ${CONFIG.emailTo}` : `   ⚠️ email lỗi ${r.status}`);
  } catch (e) { log(`   ⚠️ email error: ${e}`); }
}

// =========================== PLANNER ===============================
const STACK_BY_TYPE: Record<ProjectType, string> = {
  "web-frontend": "Vite + React + TypeScript + Tailwind (no backend)",
  "full-stack": "Next.js + Supabase (Postgres + auth)",
  cli: "Bun + TypeScript (single binary)",
  "browser-extension": "Manifest V3 + TypeScript + Vite",
};
async function makePlan(idea: Idea): Promise<Plan> {
  // PLUG REAL (USE_REAL_CLAUDE): gọi `claude -p` "Load gstack. /office-hours + /autoplan ..." → JSON
  return {
    problem: idea.why,
    tenStar: `Phiên bản 10 sao: ${idea.title} mượt tới mức người dùng không nghĩ về nó.`,
    scopeCut: "MVP 1 ngày: chỉ luồng chính.",
    stack: STACK_BY_TYPE[idea.type],
    buildSteps: ["Scaffold + tooling", "Core feature (happy path)", "Empty/error states", "Polish"],
    testPlan: [idea.type === "cli" ? "Unit + CLI smoke" : "Browser test (/qa)", "Edge cases", "Regression"],
    tasteDecisions: [`Stack: ${STACK_BY_TYPE[idea.type]} — OK?`, "Scope MVP — OK?"],
  };
}

// =========================== EMAIL =================================
function demoReadyEmail(idea: Idea, r: Result): string {
  return `<h2>🧪 Demo sẵn sàng để test: ${idea.title}</h2>
<p><b>Đang chạy trên Mac:</b> <a href="${r.localUrl}">${r.localUrl}</a> (docker đã up — mở browser test)</p>
<p><b>Repo private mới:</b> <a href="${r.repoUrl}">${r.repoUrl}</a> (branch <code>${r.branch}</code>)</p>
<p style="color:#666">Ưng thì bấm <b>Deploy</b> trên web để đẩy lên AWS.</p>`;
}
function deployedEmail(idea: Idea, url: string): string {
  return `<h2>🚀 Đã deploy: ${idea.title}</h2><p>Live: <a href="${url}">${url}</a></p>`;
}

// ========================== EXECUTOR ==============================
// gstack: implement→/review→/cso→/qa→/ship + tạo repo private + docker chạy local + CI/CD.  → demo-ready
async function runBuild(id: string): Promise<void> {
  const job = await db.getJob(id);
  if (!job) return;
  const { idea } = job as { idea: Idea };
  const cwd = `${CONFIG.builds}/${id}`;
  mkdirSync(cwd, { recursive: true });
  const port = 3000 + (Math.abs(hash(id)) % 900);

  // Sinh detailed plan (checklist) nếu chưa có (batch chỉ sinh Plan base khi insert).
  let plan = job.plan as Plan;
  if (!plan?.steps?.length) {
    jLog(id, `[plan] sinh detailed plan (Claude refinement)…`);
    plan = await generateDetailedPlan(idea, id);
    await db.setPlan(id, plan);
  }
  jLog(id, `🤖 EXECUTOR (Claude Code + gstack) — ${id}`);

  if (CONFIG.useRealClaude) {
    const ideaBrief = `Idea (EN/VN): ${idea.title_en ?? idea.title} / ${idea.title_vi ?? idea.title}
Pitch (EN/VN): ${idea.pitch_en ?? idea.pitch} / ${idea.pitch_vi ?? idea.pitch}
Why now (EN): ${idea.why_now_en ?? idea.why_en ?? "—"}
Features (EN): ${(idea.features_en ?? []).join("; ") || "—"}
Target user: ${idea.target_user_en ?? "—"}
Type: ${idea.type}
Stack đề xuất: ${plan.stack}`;

    // ─── SESSION A: IMPLEMENT (Sonnet) — scaffold + code + artifacts + git+push ───
    try {
      const implementPrompt = `Bạn là Claude Code + gstack. cwd = ${cwd}.

${ideaBrief}

SESSION NÀY = IMPLEMENT + ARTIFACTS + GITHUB. Sessions /review /cso /qa RIÊNG sẽ chạy sau — KHÔNG chạy chúng trong session này.

Nhiệm vụ:
1. Scaffold ${plan.stack} + implement core feature (happy path đủ, không empty state).
2. BẮT BUỘC 3 file ở root:
   - \`Dockerfile\` — multi-stage nếu cần. EXPOSE 3000. CMD server.
   - \`docker-compose.yml\` — service 'app', build: ., expose: [3000], restart: unless-stopped.
     KHÔNG hardcode ports (orchestrator sẽ override khi deploy).
   - \`ship.sh\` — copy NGUYÊN VĂN từ template, không sửa:
     \`cp /Users/luunguyen/Workspaces/mirotic.io/templates/ship.sh.tmpl ship.sh && chmod +x ship.sh\`
3. \`README.md\` — 1 dòng pitch + 2 lệnh: \`docker compose up\` và \`./ship.sh\`.
4. Git + GitHub:
   - \`git init && git add -A && git commit -m "init"\`
   - \`gh repo create luunguyen-dev/daily-${idea.slug} --private --source=. --push\`

KHÔNG hỏi user — autonomous.`;
      const builderModel = job.builder_model || CONFIG.modelBuilder;
      jLog(id, `[implement] ${builderModel} — scaffold + core + artifacts + git+push…`);
      await updatePlanStep(id, "scaffold", "in_progress");
      await updatePlanStep(id, "implement", "in_progress");
      await callClaudeCode(implementPrompt, cwd, id, { model: builderModel });
      await updatePlanStep(id, "scaffold", "done");
      await updatePlanStep(id, "implement", "done");
      await updatePlanStep(id, "github", "done");
      const missing = await verifyBuildArtifacts(cwd);
      if (missing.length) {
        const err = `Builder thiếu artifact: ${missing.join(", ")}`;
        jLog(id, `[verify] FAIL — ${err}`, "error");
        await updatePlanStep(id, "artifacts", "failed", err);
        await db.setResult(id, { error: err, cwd }, "failed");
        return;
      }
      await updatePlanStep(id, "artifacts", "done");
      jLog(id, `[verify] OK — Dockerfile + compose + ship.sh đủ`, "summary");
    } catch (e: any) {
      jLog(id, `[implement] FAILED: ${e?.message ?? e}`, "error");
      await updatePlanStep(id, "implement", "failed", String(e?.message ?? e));
      await db.setResult(id, { error: String(e?.message ?? e) }, "failed");
      return;
    }

    const skillTools = "Bash,Edit,Write,Read,Glob,Grep,Skill,Task";

    // ─── SESSION B: REVIEW (Haiku) — gstack /review ───
    try {
      jLog(id, `[review] ${CONFIG.modelReviewer} — gstack /review…`);
      await updatePlanStep(id, "review", "in_progress");
      const reviewPrompt = `cwd = ${cwd}. Codebase vừa qua Implement session.

Load skill /review từ gstack (invoke slash command). Đọc kỹ codebase, tìm:
- Bugs critical
- Missing error handling
- Code smells rõ ràng

Auto-apply fixes qua Edit/Write. Nếu sạch, không fix.
\`git add -A && git commit -m "review: <summary>"\` nếu có fix (không cần push, session sau push).
KHÔNG hỏi user.`;
      await callClaudeCode(reviewPrompt, cwd, id, { model: CONFIG.modelReviewer, allowedTools: skillTools });
      await updatePlanStep(id, "review", "done");
    } catch (e: any) {
      jLog(id, `[review] FAILED (không dừng build): ${e?.message ?? e}`, "error");
      await updatePlanStep(id, "review", "failed", String(e?.message ?? e));
    }

    // ─── SESSION C: CSO (Sonnet) — gstack /cso security audit ───
    try {
      jLog(id, `[cso] ${CONFIG.modelCso} — gstack /cso security audit…`);
      await updatePlanStep(id, "cso", "in_progress");
      const csoPrompt = `cwd = ${cwd}. Codebase đã qua Review.

Load skill /cso từ gstack. Security audit toàn diện, phân loại HIGH/MEDIUM/LOW.
- Auto-apply fixes HIGH + MEDIUM qua Edit/Write.
- LOW: append vào README.md dạng "## Known low-severity findings".

\`git add -A && git commit -m "cso: <summary>" && git push origin main\` nếu có commit.
KHÔNG hỏi user.`;
      await callClaudeCode(csoPrompt, cwd, id, { model: CONFIG.modelCso, allowedTools: skillTools });
      await updatePlanStep(id, "cso", "done");
    } catch (e: any) {
      jLog(id, `[cso] FAILED (không dừng build): ${e?.message ?? e}`, "error");
      await updatePlanStep(id, "cso", "failed", String(e?.message ?? e));
    }

    // ─── SESSION D: QA (Haiku) — gstack /qa smoke test ───
    try {
      jLog(id, `[qa] ${CONFIG.modelQa} — gstack /qa smoke test…`);
      await updatePlanStep(id, "qa", "in_progress");
      const qaPrompt = `cwd = ${cwd}. Codebase đã qua Implement/Review/CSO.

Load skill /qa từ gstack. Smoke test:
1. Tạo docker-compose.override.yml TẠM ở cwd:
   services:
     app:
       ports:
         - "3000:3000"
2. \`docker compose up -d --build\`. Wait 3-5s.
3. Curl \`http://localhost:3000\` hoặc \`docker compose exec app wget -qO- http://localhost:3000 | head -c 500\`. Verify HTTP 200 + HTML/JSON hợp lệ khớp idea.
4. \`docker compose down\`.
5. \`rm docker-compose.override.yml\` (KHÔNG commit file này).

Nếu container không lên trong 30s → log stderr và exit non-zero. KHÔNG hỏi user.`;
      await callClaudeCode(qaPrompt, cwd, id, { model: CONFIG.modelQa, allowedTools: skillTools });
      await updatePlanStep(id, "qa", "done");
    } catch (e: any) {
      jLog(id, `[qa] FAILED (không dừng build): ${e?.message ?? e}`, "error");
      await updatePlanStep(id, "qa", "failed", String(e?.message ?? e));
    }
  } else {
    const steps: [string, string][] = [
      ["scaffold", plan.stack], ["implement", "core feature ✓"], ["/review", "fix 3 ✓"],
      ["/cso", "1 finding low"], ["/qa", `${idea.type === "cli" ? "CLI + 6 unit" : "5 browser test + 2 ảnh"} ✓`],
      ["repo", `tạo private github.com/${CONFIG.githubOwner}/daily-${idea.slug} ✓`],
      ["docker", `docker compose up trên Mac → http://localhost:${port} (đang chạy để test) ✓`],
      ["ci/cd", "GitHub Actions → AWS đã cấu hình (chờ Deploy) ✓"],
    ];
    for (const [r, m] of steps) { await sleep(150); log(`  [${r}]`.padEnd(13) + m); }
  }

  // Khởi container local để bạn test trước khi deploy AWS (chỉ khi Claude thật đã build artifacts).
  const localPort = 3000 + (Math.abs(hash(id)) % 900);
  let repoUrl = "";
  if (CONFIG.useRealClaude) {
    await Bun.write(`${cwd}/docker-compose.override.yml`,
`services:
  app:
    ports:
      - "${localPort}:3000"
`);
    jLog(id, `[docker] docker compose up -d — port ${localPort} → container :3000`);
    await updatePlanStep(id, "local", "in_progress");
    const upProc = Bun.spawn(["docker", "compose", "up", "-d", "--build"],
      { cwd, stdout: "pipe", stderr: "pipe" });
    const upErr = await new Response(upProc.stderr).text();
    const upOut = await new Response(upProc.stdout).text();
    await upProc.exited;
    if (upProc.exitCode !== 0) {
      const errMsg = `docker compose up FAIL: ${(upErr || upOut).slice(-500)}`;
      jLog(id, `[docker] ${errMsg}`, "error");
      await updatePlanStep(id, "local", "failed", errMsg);
      await db.setResult(id, { error: errMsg } as any, "failed");
      return;
    }
    await updatePlanStep(id, "local", "done", `http://localhost:${localPort}`);
    jLog(id, `[docker] container running → http://localhost:${localPort}`, "summary");

    try {
      const gitProc = Bun.spawn(["git", "remote", "get-url", "origin"], { cwd, stdout: "pipe", stderr: "pipe" });
      repoUrl = (await new Response(gitProc.stdout).text()).trim().replace(/\.git$/, "");
      await gitProc.exited;
    } catch {}
  }

  const result: Result = {
    repoUrl: repoUrl || `https://github.com/${CONFIG.githubOwner}/daily-${idea.slug}`,
    branch: "main",
    localUrl: `http://localhost:${localPort}`,
  };
  await db.setResult(id, result, "demo-ready");
  await sendEmail(`🧪 Demo sẵn sàng: ${idea.title}`, demoReadyEmail(idea, result), "demo-ready");
  jLog(id, `✓ demo-ready · test: ${result.localUrl} · repo: ${result.repoUrl}`, "summary");
}

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
  // 3) Build: tối đa DAILY_BUILD_LIMIT ý tưởng/ngày. Claim tuần tự đến khi hit gate hoặc hết approved.
  while (true) {
    const startedToday = await db.countStartedToday();
    if (startedToday >= CONFIG.dailyBuildLimit) {
      log(`⏭️  đã thực thi ${startedToday}/${CONFIG.dailyBuildLimit} ý tưởng hôm nay — chờ ngày mai`);
      return;
    }
    const job = await db.claimNextApproved();
    if (!job) { log("⏳ chưa có ý tưởng status=approved"); return; }
    log(`▶️  build ${startedToday + 1}/${CONFIG.dailyBuildLimit} hôm nay: ${job.id}`);
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
            builder_model: full.builder_model,
            result: full.result,
            signs: {
              approve: sign(full.id, "approve"),
              reject: sign(full.id, "reject"),
              deploy: sign(full.id, "deploy"),
              promote: sign(full.id, "promote"),
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
          },
        });
      }
      if (path === "/api/pool") {
        return Response.json(await db.listPool(100));
      }
      if (path === "/api/builder-choices") {
        return Response.json({ choices: BUILDER_CHOICES, default: "sonnet" });
      }
      // Snapshot trạng thái hệ thống — dashboard hiển thị 1 dòng tóm tắt.
      if (path === "/api/status") {
        const jobs = await db.listJobs(500);
        const detailed = await Promise.all(jobs.map((j) => db.getJob(j.id)));
        const all = detailed.filter(Boolean) as any[];
        const startedToday = await db.countStartedToday();
        const todayPrefix = new Date().toISOString().slice(0, 10);
        const counts = {
          proposed: all.filter((j) => j.status === "proposed").length,
          approved: all.filter((j) => j.status === "approved").length,
          building: all.filter((j) => j.status === "building").length,
          demoReady: all.filter((j) => j.status === "demo-ready").length,
          deployRequested: all.filter((j) => j.status === "deploy-requested").length,
          deploying: all.filter((j) => j.status === "deploying").length,
          failedToday: all.filter((j) => j.status === "failed" && j.started_at?.startsWith(todayPrefix)).length,
        };
        const running = all
          .filter((j) => j.status === "building" || j.status === "deploying")
          .map((j) => ({ id: j.id, title: j.idea?.title, status: j.status, started_at: j.started_at, builder_model: j.builder_model }));
        // Next Prototyper batch — parse HH:MM, đưa về UTC ISO
        const [h, m] = CONFIG.morningAt.split(":").map(Number);
        const nowD = new Date();
        const next = new Date(nowD);
        next.setUTCHours(h - 7 < 0 ? h - 7 + 24 : h - 7, m, 0, 0);  // MORNING_AT = giờ VN, convert UTC (VN = UTC+7)
        if (next <= nowD) next.setUTCDate(next.getUTCDate() + 1);
        return Response.json({
          startedToday, dailyLimit: CONFIG.dailyBuildLimit,
          counts, running,
          nextBatchAt: next.toISOString(),
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
        const html = await Bun.file(`${import.meta.dir}/dashboard.html`).text().catch(() => null);
        if (html) return new Response(html, { headers: { "Content-Type": "text/html" } });
      }
      if (path === "/projects" || path.startsWith("/projects/")) {
        const html = await Bun.file(`${import.meta.dir}/projects.html`).text().catch(() => null);
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
