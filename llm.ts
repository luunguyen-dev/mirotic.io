/**
 * llm.ts — thin wrapper: route model name → Claude CLI hoặc Ollama HTTP.
 * Ưu tiên dùng chung cho Prototyper (batch enrich) + CEO review + Plan refinement.
 */

export type LLMOpts = { num_predict?: number; timeoutMs?: number; think?: boolean };

const isClaude = (model: string) => model.startsWith("claude-");

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

/** Router: model name quyết định backend. Claude gọi CLI, Ollama gọi HTTP. */
export async function callLLM(model: string, prompt: string, opts: LLMOpts = {}): Promise<string> {
  return isClaude(model) ? callClaude(model, prompt, opts) : callOllama(model, prompt, opts);
}

export { isClaude };
