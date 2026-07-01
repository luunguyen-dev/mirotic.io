/**
 * daily-loop.ts — Orchestrator điều khiển bởi DATABASE (web là UI).
 *
 * Luồng: Prototyper sinh ý tưởng (status=proposed) → bạn duyệt trên web (→approved)
 *  → poller mỗi 5' nhận (1 ý tưởng/ngày) → build → demo-ready (docker chạy local + repo
 *  private + CI/CD) → bạn test ở nhà → bấm Deploy trên web (→deploy-requested) → deploy AWS.
 *
 * Modes:
 *   bun run daily-loop.ts daemon    # server + sinh ý tưởng hằng ngày + poller 5' (mặc định Docker)
 *   bun run daily-loop.ts demo      # 1 vòng đầy đủ trong bộ nhớ, mock (~6s)
 *   bun run daily-loop.ts generate  # sinh 1 ý tưởng proposed rồi thoát
 *   bun run daily-loop.ts poll       # chạy 1 chu kỳ poller rồi thoát
 *   bun run daily-loop.ts serve      # chỉ dashboard + action endpoints
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
  githubOwner: env("GITHUB_OWNER", "you"),
  awsHost: env("AWS_HOST", "your-ec2-host"),
  outbox: `${DATA_DIR}/outbox`,
  builds: `${DATA_DIR}/builds`,
  useRealClaude: bool("USE_REAL_CLAUDE", false),
  // Model per step — swap không cần build lại
  modelGatherer: env("MODEL_GATHERER", "qwen3:8b"),
  modelPlanner: env("MODEL_PLANNER", "qwen3-coder:30b"),
  modelBuilder: env("MODEL_BUILDER", "claude-sonnet-4-6"),
  modelReviewer: env("MODEL_REVIEWER", "qwen3-coder:30b"),
  resendApiKey: env("RESEND_API_KEY"),
  emailFrom: env("EMAIL_FROM", "daily-loop@example.com"),
  emailTo: env("EMAIL_TO"),
};
mkdirSync(CONFIG.outbox, { recursive: true });
mkdirSync(CONFIG.builds, { recursive: true });

type Plan = {
  problem: string; tenStar: string; scopeCut: string; stack: string;
  buildSteps: string[]; testPlan: string[]; tasteDecisions: string[];
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

async function callClaudeCode(prompt: string, cwd: string, jobId?: string): Promise<string> {
  if (!CONFIG.useRealClaude) return "[mock-claude-output]";
  const proc = Bun.spawn(
    [
      "claude", "-p", prompt,
      "--model", CONFIG.modelBuilder,
      "--allowed-tools", "Bash,Edit,Write,Read,Glob,Grep,WebSearch,WebFetch,Skill,Task",
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
  const { idea, plan } = job as { idea: Idea; plan: Plan };
  const cwd = `${CONFIG.builds}/${id}`;
  mkdirSync(cwd, { recursive: true });
  const port = 3000 + (Math.abs(hash(id)) % 900);
  jLog(id, `🤖 EXECUTOR (Claude Code + gstack) — ${id}`);

  if (CONFIG.useRealClaude) {
    try {
      const prompt = `Bạn là Claude Code agent với gstack skills loaded (autoplan, review, cso, qa, ship, careful, ...).
Build project trong thư mục hiện tại: ${cwd}

Idea: ${idea.title}
Why: ${idea.why}
Pitch: ${idea.pitch}
Type: ${idea.type}
Stack đề xuất: ${plan.stack}

Quy trình gstack (chạy tuần tự, KHÔNG hỏi user trong quá trình — autonomous):
1. **Implement** — scaffold ${plan.stack}, viết core feature theo idea (happy path đủ).
   - Container EXPOSE port 3000 nội bộ (host map qua port khác khi deploy).
2. **BẮT BUỘC 3 file** trong thư mục gốc:
   - \`Dockerfile\` — multi-stage nếu cần, runtime nhẹ. EXPOSE 3000. CMD chạy server.
   - \`docker-compose.yml\` — 1 service tên \`app\`, build: ., expose 3000, restart: unless-stopped.
     KHÔNG hardcode ports mapping — orchestrator sẽ ghi đè qua docker-compose.override.yml khi deploy.
   - \`ship.sh\` — copy NGUYÊN VĂN từ template:
     \`cp /Users/luunguyen/Workspaces/mirotic.io/templates/ship.sh.tmpl ship.sh && chmod +x ship.sh\`
     ĐỪNG sửa nội dung template.
3. **\`/review\`** — review codebase, fix issues nghiêm trọng.
4. **\`/cso\`** — security review, fix HIGH/MEDIUM findings (LOW ghi vào README).
5. **\`/qa\`** — smoke test: \`docker compose up -d\`, \`curl http://localhost:3000\` healthcheck, verify happy path render đúng. \`docker compose down\` sau khi xong.
6. **README.md** — 1 dòng pitch + 2 lệnh: \`docker compose up\` và \`./ship.sh\`.
7. **Git + GitHub**:
   - \`git init && git add -A && git commit -m "init"\`
   - \`gh repo create luunguyen-dev/daily-${idea.slug} --private --source=. --push\`

KHÔNG chạy \`/ship\` (deploy AWS task riêng).
KHÔNG cần CI/CD GitHub Actions.
KHÔNG hỏi user — chạy autonomous, mọi quyết định nhỏ tự pick rồi note vào commit.`;
      jLog(id, `[claude] gọi Claude Code — có thể mất vài phút…`);
      const out = await callClaudeCode(prompt, cwd, id);
      jLog(id, `[claude] xong: ${out.slice(0, 200)}`);
      const missing = await verifyBuildArtifacts(cwd);
      if (missing.length) {
        const err = `Builder thiếu artifact bắt buộc: ${missing.join(", ")}`;
        jLog(id, `[verify] FAIL — ${err}`, "error");
        await db.setResult(id, { error: err, cwd }, "failed");
        return;
      }
      jLog(id, `[verify] OK — Dockerfile + compose + ship.sh đủ, compose config hợp lệ`, "summary");
    } catch (e: any) {
      jLog(id, `[claude] FAILED: ${e?.message ?? e}`, "error");
      await db.setResult(id, { error: String(e?.message ?? e) }, "failed");
      return;
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
    const upProc = Bun.spawn(["docker", "compose", "up", "-d", "--build"],
      { cwd, stdout: "pipe", stderr: "pipe" });
    const upErr = await new Response(upProc.stderr).text();
    const upOut = await new Response(upProc.stdout).text();
    await upProc.exited;
    if (upProc.exitCode !== 0) {
      const errMsg = `docker compose up FAIL: ${(upErr || upOut).slice(-500)}`;
      jLog(id, `[docker] ${errMsg}`, "error");
      await db.setResult(id, { error: errMsg } as any, "failed");
      return;
    }
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
    await sendEmail(`🚀 Đã deploy: ${idea.title}`, deployedEmail(idea, deployedUrl), "deployed");
    jLog(id, `✓ deployed · ${deployedUrl}`, "summary");
  } catch (e: any) {
    jLog(id, `[ship] FAILED: ${e?.message ?? e}`, "error");
    await db.setResult(id, { ...(job.result ?? {}), error: String(e?.message ?? e) }, "failed");
  }
}

// =========================== POLLER ===============================
async function pollOnce(): Promise<void> {
  // 1) Deploy requests (không giới hạn theo ngày)
  let d = await db.claimNextDeployRequested();
  while (d) { await deploy(d.id); d = await db.claimNextDeployRequested(); }
  // 2) Build: tối đa 1 ý tưởng/ngày
  if ((await db.countStartedToday()) >= 1) return log("⏭️  đã thực thi 1 ý tưởng hôm nay — chờ ngày mai");
  const job = await db.claimNextApproved();
  if (job) await runBuild(job.id);
  else log("⏳ chưa có ý tưởng status=approved");
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

// Batch (mode 'daemon' mỗi sáng): top-3 → jobs(proposed), rest → idea_pool
async function generateIdeaBatch(n = 10, topK = 3): Promise<{ jobIds: string[]; pooled: number }> {
  log(`☀️  Prototyper batch — gom ${n} candidates…`);
  const candidates: ScoredIdea[] = await batchCollect(n);
  log(`   gom được ${candidates.length} candidates (score ${candidates[0]?.score.toFixed(2) ?? "—"} → ${candidates.at(-1)?.score.toFixed(2) ?? "—"})`);

  const jobIds: string[] = [];
  for (const c of candidates.slice(0, topK)) {
    const plan = await makePlan(c);
    const id = await db.insertJob(c, plan);
    jobIds.push(id);
    log(`   → job ${id} "${c.title}" (score ${c.score.toFixed(2)})`);
  }
  let pooled = 0;
  for (const c of candidates.slice(topK)) {
    await db.insertPoolItem({
      id: `${today()}-${c.slug}-${c.source.replace(/\W/g, "")}`,
      title: c.title, pitch: c.pitch, why: c.why, source: c.source,
      url: c.url ?? null, type: c.type, score: c.score,
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
            result: full.result, signs: { approve: sign(full.id, "approve"), reject: sign(full.id, "reject"), deploy: sign(full.id, "deploy") },
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
          signs: { approve: sign(job.id, "approve"), reject: sign(job.id, "reject"), deploy: sign(job.id, "deploy") },
        });
      }
      if (path === "/api/pool") {
        return Response.json(await db.listPool(100));
      }

      // ─── Static dashboard ────────────────────────────────────
      if (path === "/" || path === "/index.html") {
        const html = await Bun.file(`${import.meta.dir}/dashboard.html`).text().catch(() => null);
        if (html) return new Response(html, { headers: { "Content-Type": "text/html" } });
      }

      // ─── HMAC action routes (giữ tương thích email link) ─────
      const [, action, id] = path.split("/");
      if (action in ACTIONS) {
        if (!verify(id, action, url.searchParams.get("t") ?? "")) return page("❌ Token sai", 403);
        if (!(await db.getJob(id))) return page("❌ Không thấy job", 404);
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
