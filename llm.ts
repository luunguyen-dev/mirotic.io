/**
 * llm.ts — thin wrapper: route model name → Claude CLI hoặc Ollama HTTP.
 * Ưu tiên dùng chung cho Prototyper (batch enrich) + CEO review + Plan refinement.
 */

export type LLMOpts = { num_predict?: number; timeoutMs?: number; think?: boolean };

const isClaude = (model: string) => model.startsWith("claude-");
const isGemini = (model: string) => model.startsWith("gemini-");

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
  const res = await fetch(url, {
    method: "POST", headers,
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: opts.num_predict ?? 8192 },
    }),
    signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data: any = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p: any) => p.text ?? "").join("") ?? "";
  return text;
}

/** Router: model name prefix quyết định backend. */
export async function callLLM(model: string, prompt: string, opts: LLMOpts = {}): Promise<string> {
  if (isClaude(model)) return callClaude(model, prompt, opts);
  if (isGemini(model)) return callGemini(model, prompt, opts);
  return callOllama(model, prompt, opts);
}

export { isClaude, isGemini };
