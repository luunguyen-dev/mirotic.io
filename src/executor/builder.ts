/**
 * builder.ts — Executor chính: runBuild() + 4 gstack sessions với auto-fallback qua model registry.
 *
 * Flow (khi CONFIG.useRealClaude=true):
 *   1. Ensure detailed plan checklist (generateDetailedPlan)
 *   2. Complexity từ CEO rating → chọn tier priority. 4 sessions dùng CÙNG complexity class.
 *   3. IMPLEMENT session: scaffold + code + artifacts + git push. Auto-fallback + user preferModel.
 *   4. REVIEW / CSO / QA sessions: mỗi cái 1 gstack skill, auto-fallback, không dừng build nếu fail.
 *   5. docker compose up local → container available cho user test.
 *   6. setResult(status=demo-ready) + email notification.
 *
 * Error handling:
 *   - IMPLEMENT ALL_COOLDOWN → requeueWithRetry(earliestReset), status → approved.
 *   - IMPLEMENT rate-limit signal single model → requeueWithRetry(reset), status → approved.
 *   - Non-limit errors → setResult failed, plan step failed.
 *   - REVIEW/CSO/QA errors → log warn, mark step failed, tiếp tục.
 */

import { mkdirSync } from "node:fs";
import { CONFIG } from "../config";
import * as db from "../db";
import { callLLM, isGpt } from "../llm";
import * as registry from "../llm/registry";
import { jLog, log, sleep } from "../util/logger";
import { parseRateLimitReset } from "../util/rate-limit";
import { sendEmail, demoReadyEmail } from "../util/email";
import { generateDetailedPlan, updatePlanStep } from "./planner";
import type { Idea, Plan, Result } from "../types";

// Detect LAN IP của Mac worker (IPv4 non-internal) — để phone/máy khác cùng WiFi truy cập demo.
// Return null nếu không tìm được.
function detectLanIP(): string | null {
  try {
    const os = require("node:os");
    const ifs = os.networkInterfaces() as Record<string, Array<{ address: string; family: string; internal: boolean }>>;
    for (const name of Object.keys(ifs)) {
      for (const info of ifs[name] ?? []) {
        if (info.family === "IPv4" && !info.internal && info.address && !info.address.startsWith("169.254.")) {
          return info.address;
        }
      }
    }
  } catch {}
  return null;
}

const hash = (s: string) => {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
};

// Verify Builder đã tạo đủ artifact + docker-compose.yml parse được.
// Mobile-expo: check app.json + eas.json + package.json + App.tsx thay vì Dockerfile.
export async function verifyBuildArtifacts(cwd: string, projectType?: string): Promise<string[]> {
  const { statSync } = await import("node:fs");
  const missing: string[] = [];
  if (projectType === "mobile-expo") {
    for (const f of ["app.json", "eas.json", "package.json", "App.tsx", "ship-mobile.sh", "README.md"]) {
      try { statSync(`${cwd}/${f}`); } catch { missing.push(f); }
    }
    if (missing.length === 0) {
      // Verify package.json có deps expo + react-native
      try {
        const pkg = JSON.parse(await Bun.file(`${cwd}/package.json`).text());
        if (!pkg.dependencies?.expo) missing.push("package.json (missing expo dependency)");
        if (!pkg.dependencies?.["react-native"]) missing.push("package.json (missing react-native dependency)");
      } catch (e: any) { missing.push(`package.json parse err: ${e?.message}`); }
    }
    return missing;
  }
  // Web/full-stack/cli/browser-extension: docker path
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

// Codex CLI agentic session — cho MODEL=gpt-*. Sandbox workspace-write, approval=never.
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

// Claude Code CLI wrapper — 1 session với stream-json event parse → job_logs.
async function callClaudeCode(
  prompt: string, cwd: string, jobId?: string,
  opts: { model?: string; allowedTools?: string } = {},
): Promise<string> {
  if (!CONFIG.useRealClaude) return "[mock-claude-output]";
  const model = opts.model ?? CONFIG.modelBuilder;
  // Route GPT-* → Codex CLI (agentic sandbox). Claude CLI cho claude-*.
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
  const streamParse = async (stream: ReadableStream<Uint8Array>, isStderr = false) => {
    const reader = stream.getReader(); const decoder = new TextDecoder(); let buffer = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        (isStderr ? process.stderr : process.stdout).write(line + "\n");
        if (jobId) await parseClaudeEventToLog(line, jobId).catch(() => {});
      }
    }
  };
  await Promise.all([streamParse(proc.stdout as any), streamParse(proc.stderr as any, true)]);
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
    // Aggregate lên jobs.total_turns + total_cost_usd cho card summary.
    const turns = Number(ev.num_turns ?? 0);
    const usd = Number(ev.total_cost_usd ?? 0);
    if (turns > 0 || usd > 0) await db.addJobCost(jobId, turns, usd);
  }
}

/**
 * Try running an agentic session với auto-fallback qua registry.
 * Nếu model hit limit → parseRateLimitReset → markCooldown → thử next model.
 * @param preferModel  Nếu set (user pick manual), thử model đó ĐẦU TIÊN. Vẫn fallback nếu hit limit.
 * Trả về { model, output }. Throw ALL_COOLDOWN nếu tất cả candidate cooldown.
 */
async function runAgenticWithFallback(
  scope: string,
  complexity: registry.ComplexityClass,
  prompt: string, cwd: string, jobId: string,
  opts: { allowedTools?: string; preferModel?: string } = {},
): Promise<{ model: string; output: string }> {
  const tried: string[] = [];
  const MAX_ATTEMPTS = 4;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let model: string;
    if (attempt === 0 && opts.preferModel && !tried.includes(opts.preferModel)) {
      model = opts.preferModel;
      const cds = registry.getCooldowns();
      if (cds[model] && cds[model] > new Date().toISOString()) {
        jLog(jobId, `[${scope}] user-pick ${model} đang cooldown → chuyển router`, "info");
        model = "";
      }
    } else {
      model = "";
    }
    if (!model) {
      try { model = await registry.pickModel("agentic", complexity, { exclude: tried }); }
      catch (e: any) {
        throw Object.assign(new Error(`[${scope}] all agentic models cooling down; earliest reset ${e.earliestReset}`),
          { code: "ALL_COOLDOWN", earliestReset: e.earliestReset });
      }
    }
    if (tried.includes(model)) {
      throw new Error(`[${scope}] router exhausted after trying ${tried.join(", ")}`);
    }
    tried.push(model);
    const est = registry.estimateCost(model);
    const tag = opts.preferModel === model ? " (user pick)" : "";
    jLog(jobId, `[${scope}] ${model}${tag} (${complexity}, est $${est.toFixed(3)})`);
    try {
      const output = await callClaudeCode(prompt, cwd, jobId, { model, allowedTools: opts.allowedTools });
      return { model, output };
    } catch (e: any) {
      const errMsg = String(e?.message ?? e);
      const recent = await db.getLogs(jobId, 0, 500).catch(() => [] as any[]);
      const combined = errMsg + "\n" + recent.slice(-40).map((l: any) => l.line ?? "").join("\n");
      const resetAt = parseRateLimitReset(combined);
      if (resetAt) {
        jLog(jobId, `[${scope}] ${model} HIT LIMIT — cooldown ${resetAt}, thử fallback…`, "error");
        await registry.markCooldown(model, resetAt, `${scope} session hit limit`);
        continue;
      }
      // Runtime CLI thiếu (codex/claude không cài trong env này) → fallback sang model kế tiếp
      // qua exclude[]. Không mark cooldown DB (cooldown share giữa worker/container).
      if (/exited (1|127)|command not found|not installed|ENOENT|No such file|Executable not found/i.test(combined)) {
        jLog(jobId, `[${scope}] ${model} runtime CLI thiếu → thử fallback…`, "error");
        continue;
      }
      throw e;
    }
  }
  throw new Error(`[${scope}] exhausted ${MAX_ATTEMPTS} attempts (tried ${tried.join(", ")})`);
}

// ────────────────────────────────────────────────────────────────────────
// MAIN: runBuild
// ────────────────────────────────────────────────────────────────────────
// gstack: implement → /review → /cso → /qa → local docker up → demo-ready
export async function runBuild(id: string): Promise<void> {
  const job = await db.getJob(id);
  if (!job) return;
  const { idea } = job as { idea: Idea };
  const cwd = `${CONFIG.builds}/${id}`;
  mkdirSync(cwd, { recursive: true });
  const port = 3000 + (Math.abs(hash(id)) % 900);

  // Sinh detailed plan (checklist) nếu chưa có.
  let plan = job.plan as Plan;
  if (!plan?.steps?.length) {
    jLog(id, `[plan] sinh detailed plan (Claude refinement)…`);
    plan = await generateDetailedPlan(idea, id);
    await db.setPlan(id, plan);
  }
  jLog(id, `🤖 EXECUTOR (Claude Code + gstack) — ${id}`);

  // Skip-if-done: retry sau khi 1 số step failed sẽ chỉ chạy lại step chưa done.
  // Session A gộp scaffold + implement + artifacts + github → skip khi implement đã done.
  const stepStatus = (key: string) =>
    plan.steps?.find((s: any) => s.key === key)?.status ?? "pending";

  if (CONFIG.useRealClaude) {
    // Complexity từ CEO rating → chọn tier priority. 4 sessions dùng cùng class để giữ context.
    const complexity: registry.ComplexityClass = registry.complexityFromRating(job.ceo_rating);
    const jobBuilderModel = job.builder_model;
    const estimateTotal = ["complex", "medium", "simple"].includes(complexity)
      ? registry.estimateCost(registry.AGENTIC_PRIORITY[complexity][0]) * 4
      : 0;
    jLog(id, `📊 Build plan: complexity=${complexity}, est ~$${estimateTotal.toFixed(2)} (4 sessions × primary model)`, "summary");

    const ideaBrief = `Idea (EN/VN): ${idea.title_en ?? idea.title} / ${idea.title_vi ?? idea.title}
Pitch (EN/VN): ${idea.pitch_en ?? idea.pitch} / ${idea.pitch_vi ?? idea.pitch}
Why now (EN): ${idea.why_now_en ?? idea.why_en ?? "—"}
Features (EN): ${(idea.features_en ?? []).join("; ") || "—"}
Target user: ${idea.target_user_en ?? "—"}
Type: ${idea.type}
Stack đề xuất: ${plan.stack}`;

    // ─── SESSION A: IMPLEMENT ───
    if (stepStatus("implement") === "done") {
      jLog(id, `[implement] skip (đã done, retry mode)`, "summary");
    } else try {
      const isMobile = idea.type === "mobile-expo";
      const implementPrompt = isMobile
        ? `Bạn là Claude Code + gstack. cwd = ${cwd}.

${ideaBrief}

SESSION NÀY = SCAFFOLD + IMPLEMENT + ARTIFACTS + GITHUB. Sessions /review /cso /qa RIÊNG sẽ chạy sau — KHÔNG chạy chúng trong session này.

Nhiệm vụ (mobile-expo — React Native + Expo Managed workflow):

1. Copy scaffold từ templates/mobile-expo/ về cwd:
   - \`cp /Users/luunguyen/Workspaces/mirotic.io/templates/mobile-expo/app.json.tmpl app.json\`
   - \`cp /Users/luunguyen/Workspaces/mirotic.io/templates/mobile-expo/eas.json.tmpl eas.json\`
   - \`cp /Users/luunguyen/Workspaces/mirotic.io/templates/mobile-expo/package.json.tmpl package.json\`
   - \`cp /Users/luunguyen/Workspaces/mirotic.io/templates/mobile-expo/App.tsx.tmpl App.tsx\`
   - \`cp /Users/luunguyen/Workspaces/mirotic.io/templates/mobile-expo/tsconfig.json.tmpl tsconfig.json\`
   - \`cp /Users/luunguyen/Workspaces/mirotic.io/templates/mobile-expo/gitignore.tmpl .gitignore\`
   - \`cp /Users/luunguyen/Workspaces/mirotic.io/templates/mobile-expo/ship-mobile.sh.tmpl ship-mobile.sh && chmod +x ship-mobile.sh\`

2. Thay placeholder trong các file vừa copy:
   - \`{SLUG}\` → \`${idea.slug}\`
   - \`{SLUG_TITLE}\` → \`${(idea.title_en ?? idea.title).replace(/"/g, '\\"')}\`
   - \`{SLUG_CAMEL}\` → slug với dấu \`-\` bỏ đi (${idea.slug.replace(/-/g, "")})
   - \`{PITCH_EN}\` → pitch EN
   - \`{EAS_PROJECT_ID}\` để \`{EAS_PROJECT_ID}\` (EAS sẽ tự khởi tạo khi \`eas init\`)

3. Implement core feature trong App.tsx:
   - Dùng React Native primitives (View, Text, Pressable, TextInput, ScrollView, FlatList...).
   - StyleSheet.create — KHÔNG dùng CSS/HTML/className.
   - Portrait-first, offline-first (không cần network).
   - Happy path đủ — feature core hoạt động thật, không empty state.
   - Nếu cần navigation multi-screen, dùng expo-router (đã có trong package.json).

4. \`npm install\` (RN dùng npm, không dùng bun).

5. Verify:
   - \`npx expo-doctor\` (nếu fail, fix rồi retry).
   - \`npx tsc --noEmit\` — không lỗi type.

6. \`README.md\` — 1 dòng pitch + hướng dẫn: \`npm start\` (dev tunnel) và \`./ship-mobile.sh\` (build APK).

7. Git + GitHub:
   - \`git init && git add -A && git commit -m "init"\`
   - \`gh repo create luunguyen-dev/mirotic-${idea.slug} --private --source=. --push\`

KHÔNG hỏi user — autonomous.`
        : `Bạn là Claude Code + gstack. cwd = ${cwd}.

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
   - \`gh repo create luunguyen-dev/mirotic-${idea.slug} --private --source=. --push\`

KHÔNG hỏi user — autonomous.`;
      await updatePlanStep(id, "scaffold", "in_progress");
      await updatePlanStep(id, "implement", "in_progress");
      const implementResult = await runAgenticWithFallback("implement", complexity, implementPrompt, cwd, id,
        { preferModel: jobBuilderModel ?? undefined });
      // Ghi model thực sự dùng (đặc biệt hữu ích khi auto — dashboard hiển thị model dimmer bên chữ Auto).
      await db.setBuilderModelUsed(id, implementResult.model);
      await updatePlanStep(id, "scaffold", "done");
      await updatePlanStep(id, "implement", "done");
      await updatePlanStep(id, "github", "done");
      const missing = await verifyBuildArtifacts(cwd, idea.type);
      if (missing.length) {
        const err = `Builder thiếu artifact: ${missing.join(", ")}`;
        jLog(id, `[verify] FAIL — ${err}`, "error");
        await updatePlanStep(id, "artifacts", "failed", err);
        await db.setResult(id, { error: err, cwd }, "failed");
        return;
      }
      await updatePlanStep(id, "artifacts", "done");
      jLog(id, isMobile ? `[verify] OK — app.json + eas.json + package.json đủ` : `[verify] OK — Dockerfile + compose + ship.sh đủ`, "summary");
    } catch (e: any) {
      const errMsg = String(e?.message ?? e);
      if (e?.code === "ALL_COOLDOWN") {
        const resetAt = e.earliestReset;
        const waitMin = Math.ceil((new Date(resetAt).getTime() - Date.now()) / 60000);
        jLog(id, `[implement] ALL AGENTIC COOLDOWN: retry sau ${waitMin} phút (${resetAt})`, "error");
        await updatePlanStep(id, "implement", "pending", `all-model cooldown until ${resetAt}`);
        await db.requeueWithRetry(id, resetAt, `ALL_COOLDOWN: reset ${resetAt}`);
        return;
      }
      const recent = await db.getLogs(id, 0, 500).catch(() => [] as any[]);
      const combined = errMsg + "\n" + recent.slice(-40).map((l: any) => l.line ?? "").join("\n");
      const resetAt = parseRateLimitReset(combined);
      if (resetAt) {
        const waitMin = Math.ceil((new Date(resetAt).getTime() - Date.now()) / 60000);
        jLog(id, `[implement] RATE-LIMIT: retry sau ${waitMin} phút (reset ${resetAt})`, "error");
        await updatePlanStep(id, "implement", "pending", `waiting for reset ${resetAt}`);
        await db.requeueWithRetry(id, resetAt, `RATE_LIMIT: reset ${resetAt}`);
        return;
      }
      jLog(id, `[implement] FAILED: ${errMsg}`, "error");
      await updatePlanStep(id, "implement", "failed", errMsg);
      await db.setResult(id, { error: errMsg }, "failed");
      return;
    }

    const skillTools = "Bash,Edit,Write,Read,Glob,Grep,Skill,Task";

    // ─── SESSION B: REVIEW ───
    if (stepStatus("review") === "done") {
      jLog(id, `[review] skip (đã done)`, "summary");
    } else try {
      await updatePlanStep(id, "review", "in_progress");
      const reviewPrompt = `cwd = ${cwd}. Codebase vừa qua Implement session.

Load skill /review từ gstack (invoke slash command). Đọc kỹ codebase, tìm:
- Bugs critical
- Missing error handling
- Code smells rõ ràng

Auto-apply fixes qua Edit/Write. Nếu sạch, không fix.
\`git add -A && git commit -m "review: <summary>"\` nếu có fix (không cần push, session sau push).
KHÔNG hỏi user.`;
      await runAgenticWithFallback("review", complexity, reviewPrompt, cwd, id, { allowedTools: skillTools });
      await updatePlanStep(id, "review", "done");
    } catch (e: any) {
      jLog(id, `[review] FAILED (không dừng build): ${e?.message ?? e}`, "error");
      await updatePlanStep(id, "review", "failed", String(e?.message ?? e));
    }

    // ─── SESSION C: CSO ───
    if (stepStatus("cso") === "done") {
      jLog(id, `[cso] skip (đã done)`, "summary");
    } else try {
      await updatePlanStep(id, "cso", "in_progress");
      const csoPrompt = `cwd = ${cwd}. Codebase đã qua Review.

Load skill /cso từ gstack. Security audit toàn diện, phân loại HIGH/MEDIUM/LOW.
- Auto-apply fixes HIGH + MEDIUM qua Edit/Write.
- LOW: append vào README.md dạng "## Known low-severity findings".

\`git add -A && git commit -m "cso: <summary>" && git push origin main\` nếu có commit.
KHÔNG hỏi user.`;
      await runAgenticWithFallback("cso", complexity, csoPrompt, cwd, id, { allowedTools: skillTools });
      await updatePlanStep(id, "cso", "done");
    } catch (e: any) {
      jLog(id, `[cso] FAILED (không dừng build): ${e?.message ?? e}`, "error");
      await updatePlanStep(id, "cso", "failed", String(e?.message ?? e));
    }

    // ─── SESSION D: QA ───
    if (stepStatus("qa") === "done") {
      jLog(id, `[qa] skip (đã done)`, "summary");
    } else try {
      await updatePlanStep(id, "qa", "in_progress");
      const qaPrompt = idea.type === "mobile-expo" ? `cwd = ${cwd}. Codebase Expo/RN đã qua Implement/Review/CSO.

Load skill /qa từ gstack. Smoke test cho Expo Managed workflow:
1. \`npx expo-doctor\` — verify project setup lành mạnh. Nếu fail, sửa rồi retry.
2. \`npx tsc --noEmit\` — no type errors.
3. \`npx expo export --platform web --output-dir /tmp/expo-web-${idea.slug}\` — verify JS bundle build được (test cross-platform Metro bundler).
4. Nếu expo export succeed, verify /tmp/expo-web-${idea.slug}/index.html tồn tại.
5. Cleanup: \`rm -rf /tmp/expo-web-${idea.slug}\`

KHÔNG cần chạy \`expo start --tunnel\` (user sẽ tự chạy khi muốn quét QR test).
Nếu bất cứ bước nào fail → log stderr và exit non-zero. KHÔNG hỏi user.` : `cwd = ${cwd}. Codebase đã qua Implement/Review/CSO.

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
      await runAgenticWithFallback("qa", complexity, qaPrompt, cwd, id, { allowedTools: skillTools });
      await updatePlanStep(id, "qa", "done");
    } catch (e: any) {
      jLog(id, `[qa] FAILED (không dừng build): ${e?.message ?? e}`, "error");
      await updatePlanStep(id, "qa", "failed", String(e?.message ?? e));
    }
  } else {
    // Mock mode
    const steps: [string, string][] = [
      ["scaffold", plan.stack], ["implement", "core feature ✓"], ["/review", "fix 3 ✓"],
      ["/cso", "1 finding low"], ["/qa", `${idea.type === "cli" ? "CLI + 6 unit" : "5 browser test + 2 ảnh"} ✓`],
      ["repo", `tạo private github.com/${CONFIG.githubOwner}/mirotic-${idea.slug} ✓`],
      ["docker", `docker compose up trên Mac → http://localhost:${port} (đang chạy để test) ✓`],
      ["ci/cd", "GitHub Actions → AWS đã cấu hình (chờ Deploy) ✓"],
    ];
    for (const [r, m] of steps) { await sleep(150); log(`  [${r}]`.padEnd(13) + m); }
  }

  // Khởi container local (web) hoặc Expo tunnel (mobile) để user test trước khi deploy AWS.
  const localPort = 3000 + (Math.abs(hash(id)) % 900);
  let repoUrl = "";
  let expoUrl: string | undefined;
  let expoQr: string | undefined;
  const localAlreadyDone = stepStatus("local") === "done";
  const isMobileType = idea.type === "mobile-expo";
  if (CONFIG.useRealClaude && !localAlreadyDone) {
    if (isMobileType) {
      // Mobile: auto-start `expo start --web` background trên Mac worker.
      // Bundle react-native-web ra http://localhost:<port> — user click Local link để mở browser.
      // Fallback: cliHint để user chạy tay `expo start` (LAN) hoặc `expo start --tunnel` (QR).
      jLog(id, `[expo] npx expo start --web --port ${localPort} (background)`);
      await updatePlanStep(id, "local", "in_progress");
      const startResult = await startExpoWeb(cwd, id, localPort);
      if (!startResult.url) {
        // Không dừng build — mark done với cliHint để user vẫn chạy tay được.
        jLog(id, `[expo] auto-start web fail (${startResult.error?.slice(0, 80)}), fallback → cliHint`, "error");
        await updatePlanStep(id, "local", "done", `cd ${cwd} && npx expo start --web`);
      } else {
        await updatePlanStep(id, "local", "done", startResult.url);
        jLog(id, `[expo] web preview: ${startResult.url}`, "summary");
      }
    } else {
      // Web/full-stack/cli/browser-extension: docker compose up
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
    }

    try {
      const gitProc = Bun.spawn(["git", "remote", "get-url", "origin"], { cwd, stdout: "pipe", stderr: "pipe" });
      repoUrl = (await new Response(gitProc.stdout).text()).trim().replace(/\.git$/, "");
      await gitProc.exited;
    } catch {}
  }

  // Mobile: localUrl = expo web preview (Metro serve trên localPort). Nếu web start fail
  // thì stepStatus("local") note giữ nguyên cliHint và localUrl có thể trống.
  const localNote = (plan.steps ?? []).find((s: any) => s.key === "local")?.note as string | undefined;
  const localUrlFromStep = localNote?.startsWith("http") ? localNote : undefined;
  const lanIP = detectLanIP();
  const lanUrl = lanIP
    ? (isMobileType
        ? (localUrlFromStep ? localUrlFromStep.replace(/localhost/, lanIP) : undefined)
        : `http://${lanIP}:${localPort}`)
    : undefined;
  const result: Result = {
    repoUrl: repoUrl || `https://github.com/${CONFIG.githubOwner}/mirotic-${idea.slug}`,
    branch: "main",
    localUrl: isMobileType ? (localUrlFromStep ?? "") : `http://localhost:${localPort}`,
    ...(lanUrl ? { lanUrl } : {}),
    ...(expoUrl ? { expoUrl } : {}),
    ...(expoQr ? { expoQr } : {}),
    ...(isMobileType ? { cliHint: `cd ${cwd} && npx expo start --tunnel   # quét QR bằng Expo Go trên điện thoại` } : {}),
  };
  await db.setResult(id, result, "demo-ready");
  await sendEmail(`🧪 Demo sẵn sàng: ${idea.title}`, demoReadyEmail(idea, result), "demo-ready");
  jLog(id, `✓ demo-ready · test: ${isMobileType ? (expoUrl ?? "expo tunnel") : result.localUrl} · repo: ${result.repoUrl}`, "summary");
}

// Chạy `npx expo start --web --port N` ở background, poll HTTP để chờ Metro serve URL.
// Return { url } khi HTTP 200; error nếu timeout. KHÔNG kill process (user browse).
async function startExpoWeb(cwd: string, jobId: string, port: number): Promise<{ url?: string; error?: string }> {
  const url = `http://localhost:${port}`;
  const proc = Bun.spawn(
    ["npx", "expo", "start", "--web", "--port", String(port)],
    { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "1", EXPO_NO_TELEMETRY: "1", BROWSER: "none" } }
  );
  // Log stdout songsong (non-blocking) — không gate cho phần chờ HTTP.
  (async () => {
    const reader = proc.stdout.getReader(); const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) break;
      const chunk = dec.decode(value!, { stream: true });
      await db.appendLog(jobId, chunk.trim().slice(0, 300), "tool").catch(() => {});
    }
  })().catch(() => {});
  // Poll HTTP mỗi 5s tới 3 phút — Metro bundle lần đầu có thể chậm.
  const timeoutMs = 180_000;
  const startAt = Date.now();
  while (Date.now() - startAt < timeoutMs) {
    if (proc.exitCode !== null) {
      return { error: `expo start exited early code=${proc.exitCode}` };
    }
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.status < 500) return { url };
    } catch {}
    await new Promise((res) => setTimeout(res, 5000));
  }
  proc.kill();
  return { error: `HTTP ${url} không lên sau ${timeoutMs}ms` };
}

// (legacy) Chạy `npx expo start --tunnel --non-interactive` — giữ nếu tương lai cần QR flow.
async function _startExpoTunnel(cwd: string, jobId: string, port: number): Promise<{ url?: string; qr?: string; error?: string }> {
  const QRCode = await import("qrcode").catch(() => null);
  if (!QRCode) return { error: "qrcode package chưa cài (npm install qrcode)" };
  const proc = Bun.spawn(
    ["npx", "expo", "start", "--tunnel", "--non-interactive", "--port", String(port)],
    { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, CI: "1", EXPO_NO_TELEMETRY: "1" } }
  );
  const timeoutMs = 90_000;
  const startAt = Date.now();
  let buffer = "";
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  try {
    while (Date.now() - startAt < timeoutMs) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((res) => setTimeout(() => res({ done: true, value: undefined }), 5000)),
      ]);
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      await db.appendLog(jobId, chunk.trim().slice(0, 300), "tool").catch(() => {});
      // Search for exp:// URL
      const m = buffer.match(/exp:\/\/[a-zA-Z0-9.\-_/]+/);
      if (m) {
        const url = m[0];
        const qr = await QRCode.toDataURL(url, { width: 300, margin: 1 }).catch(() => undefined);
        // KHÔNG kill process — để user quét. Chỉ detach từ reader.
        reader.releaseLock();
        return { url, qr };
      }
    }
    reader.releaseLock();
    proc.kill();
    return { error: `tunnel URL không xuất hiện sau ${timeoutMs}ms; buffer tail: ${buffer.slice(-200)}` };
  } catch (e: any) {
    try { reader.releaseLock(); } catch {}
    proc.kill();
    return { error: String(e?.message ?? e) };
  }
}
