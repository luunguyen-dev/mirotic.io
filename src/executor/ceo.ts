/**
 * ceo.ts — Text tier LLM wrapper + CEO review.
 *   - callClaudeText: retry-only wrapper cho legacy code
 *   - callTextWithFallback: route theo role qua registry, auto-fallback rate-limit
 *   - ceoReview: 1-turn Claude/OpenAI/Gemini rating idea 1-5⭐
 */

import { CONFIG } from "../config";
import { callLLM } from "../llm";
import * as registry from "../llm/registry";
import { log } from "../util/logger";
import { parseRateLimitReset } from "../util/rate-limit";
import type { Idea } from "../types";

// Legacy retry wrapper — không route qua registry. Giữ cho compat.
export async function callClaudeText(
  prompt: string,
  opts: { model?: string; timeoutMs?: number; retries?: number } = {},
): Promise<string> {
  if (!CONFIG.useRealClaude) return "";
  const model = opts.model ?? CONFIG.modelBuilder;
  const retries = opts.retries ?? 2;
  let lastErr: any;
  for (let i = 0; i <= retries; i++) {
    try { return await callLLM(model, prompt, { timeoutMs: opts.timeoutMs }); }
    catch (e: any) {
      lastErr = e;
      if (i < retries) await new Promise((r) => setTimeout(r, (i + 1) * 2000));
    }
  }
  throw lastErr;
}

/**
 * Router text-tier: pick model theo role, auto-fallback nếu cooldown / limit.
 * Ollama qwen3:8b luôn ở cuối list — nếu tất cả cloud fail, dùng nó (chất lượng thấp).
 */
export async function callTextWithFallback(
  role: registry.TextRole,
  prompt: string,
  opts: { timeoutMs?: number; num_predict?: number } = {},
): Promise<{ model: string; output: string }> {
  const tried: string[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    let model: string;
    try { model = await registry.pickModel("text", role, { exclude: tried }); }
    catch (e: any) {
      throw Object.assign(new Error(`[${role}] all text models cooling down; earliest reset ${e.earliestReset}`),
        { code: "ALL_COOLDOWN", earliestReset: e.earliestReset });
    }
    tried.push(model);
    try {
      const output = await callLLM(model, prompt, { timeoutMs: opts.timeoutMs, num_predict: opts.num_predict });
      return { model, output };
    } catch (e: any) {
      const errMsg = String(e?.message ?? e);
      const resetAt = parseRateLimitReset(errMsg);
      if (resetAt) {
        log(`   [${role}] ${model} HIT LIMIT → cooldown ${resetAt}, thử fallback`);
        await registry.markCooldown(model, resetAt, `${role} text call hit limit`);
        continue;
      }
      // Runtime CLI thiếu — không mark cooldown, chỉ next model qua exclude.
      if (/exited (1|127)|command not found|not installed|ENOENT|no such file|Executable not found/i.test(errMsg)) {
        log(`   [${role}] ${model} runtime CLI thiếu → thử fallback`);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`[${role}] exhausted fallback (tried ${tried.join(", ")})`);
}

// CEO review 1 idea — 1-turn, output rating 1-5 + critique EN/VI.
// Router text-tier tự chọn model khả dụng (Claude → GPT → Gemini REST → Ollama),
// nên không cần check USE_REAL_CLAUDE — container dashboard vẫn CEO được qua Gemini.
export async function ceoReview(idea: Idea): Promise<{ rating: number; critique: { en: string; vi: string } } | null> {
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
    const { output: raw } = await callTextWithFallback("ceo", prompt, { timeoutMs: 60_000 });
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
