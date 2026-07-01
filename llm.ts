/**
 * llm.ts — thin wrapper: route model name → Claude CLI hoặc Ollama HTTP.
 * Ưu tiên dùng chung cho Prototyper (batch enrich) + CEO review + Plan refinement.
 */

export type LLMOpts = {
  num_predict?: number;
  timeoutMs?: number;
  think?: boolean;              // Ollama: bật/tắt thinking output
  thinkingBudget?: number;       // Gemini: -1 = dynamic (High), 0 = off, >0 = fixed tokens
};

const isClaude = (model: string) => model.startsWith("claude-");
const isGemini = (model: string) => model.startsWith("gemini-");
const isGpt = (model: string) => model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3");

export async function callOllama(model: string, prompt: string, opts: LLMOpts = {}): Promise<string> {
  const url = process.env.OLLAMA_URL || "http://localhost:11434";
  const res = await fetch(`${url}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model, prompt, stream: false,
      think: opts.think ?? false,
      options: { num_predict: opts.num_predict ?? 4096, temperature: 0.3 },
    }),
  });
  return (await res.json()).response as string;
}

/** claude -p <prompt> --model X --output-format json  → trả .result (text). */
export async function callClaude(model: string, prompt: string, opts: LLMOpts = {}): Promise<string> {
  const proc = Bun.spawn(
    ["claude", "-p", prompt, "--model", model, "--output-format", "json"],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env } }
  );
  const timeout = setTimeout(() => proc.kill(), opts.timeoutMs ?? 120_000);
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  clearTimeout(timeout);
  if (proc.exitCode !== 0) throw new Error(`claude exited ${proc.exitCode}`);
  try {
    const parsed = JSON.parse(out);
    return (parsed.result ?? parsed.response ?? out) as string;
  } catch { return out; }
}

/** Gemini via Google GenAI REST. Key format:
 *   - "AIza..." (API key)         → x-goog-api-key header
 *   - "AQ..."/"ya29..."/anything khác → Authorization: Bearer (OAuth access token)
 */
export async function callGemini(model: string, prompt: string, opts: LLMOpts = {}): Promise<string> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY chưa set");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key.startsWith("AIza")) headers["x-goog-api-key"] = key;
  else headers["Authorization"] = `Bearer ${key}`;
  const generationConfig: any = { temperature: 0.7, maxOutputTokens: opts.num_predict ?? 8192 };
  if (opts.thinkingBudget !== undefined) generationConfig.thinkingConfig = { thinkingBudget: opts.thinkingBudget };
  const res = await fetch(url, {
    method: "POST", headers,
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig,
    }),
    signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data: any = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
  return text;
}

/** OpenAI GPT via Codex CLI — dùng session Codex đã login (`codex login`). Reasoning effort
 *  lấy từ ~/.codex/config.toml (mặc định "high"). Có thể override qua opts.thinkingBudget:
 *  -1 → high, 0 → minimal, >0 → medium. */
export async function callCodex(model: string, prompt: string, opts: LLMOpts = {}): Promise<string> {
  const outFile = `/tmp/codex-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`;
  const args = ["exec", "-m", model, "--output-last-message", outFile];
  if (opts.thinkingBudget !== undefined) {
    const effort = opts.thinkingBudget < 0 ? "high" : opts.thinkingBudget === 0 ? "minimal" : "medium";
    args.push("-c", `model_reasoning_effort="${effort}"`);
  }
  args.push(prompt);
  const proc = Bun.spawn(["codex", ...args], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const timeout = setTimeout(() => proc.kill(), opts.timeoutMs ?? 300_000);
  await proc.exited;
  clearTimeout(timeout);
  const text = await Bun.file(outFile).text().catch(() => "");
  try { await Bun.$`rm -f ${outFile}`.quiet(); } catch {}
  if (proc.exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text().catch(() => "");
    throw new Error(`codex exited ${proc.exitCode}: ${(stderr || text).slice(0, 300)}`);
  }
  return text.trim();
}

/** Router: model name prefix quyết định backend. */
export async function callLLM(model: string, prompt: string, opts: LLMOpts = {}): Promise<string> {
  if (isClaude(model)) return callClaude(model, prompt, opts);
  if (isGemini(model)) return callGemini(model, prompt, opts);
  if (isGpt(model)) return callCodex(model, prompt, opts);
  return callOllama(model, prompt, opts);
}

export { isClaude, isGemini, isGpt };
