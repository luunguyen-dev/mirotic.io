/**
 * model-registry.ts — model metadata + priority-based router với circuit-breaker cooldown.
 *
 * Concept:
 *   - AGENTIC tier: gstack sessions (IMPLEMENT/REVIEW/CSO/QA). Complexity-adaptive.
 *   - TEXT tier: 1-turn calls (Prototyper/CEO/Planner). Role-based.
 *   - Cooldown persist trong DB (model_cooldowns) → survive worker restart.
 */

import * as db from "../db";

export type Tier = "agentic" | "text";
export type ComplexityClass = "complex" | "medium" | "simple";
export type TextRole = "prototyper" | "ceo" | "planner";

export type ModelMeta = {
  name: string;
  tier: Tier;
  // Cost tham chiếu API price ($/1M tokens). Trên Max plan = 0 effectively, dùng để log estimate.
  cost_in: number;   // $/1M input tokens
  cost_out: number;  // $/1M output tokens
};

// Registry — 6 model đã verify khả dụng.
export const MODELS: Record<string, ModelMeta> = {
  "claude-opus-4-8":            { name: "claude-opus-4-8",             tier: "agentic", cost_in: 15,   cost_out: 75 },
  "claude-sonnet-5":            { name: "claude-sonnet-5",             tier: "agentic", cost_in: 3,    cost_out: 15 },
  "claude-haiku-4-5-20251001":  { name: "claude-haiku-4-5-20251001",   tier: "text",    cost_in: 1,    cost_out: 5 },
  "gpt-5.5":                    { name: "gpt-5.5",                     tier: "agentic", cost_in: 10,   cost_out: 40 },
  "gemini-2.5-pro":             { name: "gemini-2.5-pro",              tier: "text",    cost_in: 0.1,  cost_out: 0.4 },
  "qwen3:8b":                   { name: "qwen3:8b",                    tier: "text",    cost_in: 0,    cost_out: 0 },
};

// Priority ordering theo user quyết định.
// AGENTIC — complexity từ CEO rating (4-5⭐ = complex, 2-3⭐ = medium, 1⭐/null = simple).
// QUAN TRỌNG: tier 1 và tier 2 phải KHÁC VENDOR để tránh cả 2 cùng bị session limit
// khi Claude Max quota hoặc OpenAI rate limit hit. Fallback qua tier 2 vẫn dùng được.
export const AGENTIC_PRIORITY: Record<ComplexityClass, string[]> = {
  complex: ["claude-sonnet-5", "gpt-5.5", "claude-opus-4-8"],
  medium:  ["claude-opus-4-8", "gpt-5.5", "claude-sonnet-5"],
  simple:  ["gpt-5.5", "claude-sonnet-5", "claude-opus-4-8"],
};

// TEXT — role-based. Gemini có REST khả dụng ở mọi env (kể cả dashboard container không có claude/codex CLI).
// Ollama qwen3:8b luôn cuối cùng khi tất cả cloud fail.
export const TEXT_PRIORITY: Record<TextRole, string[]> = {
  prototyper: ["claude-opus-4-8", "gpt-5.5", "gemini-2.5-pro", "qwen3:8b"],
  ceo:        ["claude-opus-4-8", "gpt-5.5", "gemini-2.5-pro", "qwen3:8b"],
  planner:    ["gpt-5.5", "claude-sonnet-5", "gemini-2.5-pro", "qwen3:8b"],
};

// In-memory cooldown cache — sync với DB periodic + on setCooldown.
let cooldowns: Record<string, string> = {};   // model → ISO cooldown_until
let lastLoadAt = 0;

async function loadCooldowns(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastLoadAt < 30_000) return;    // cache 30s
  try {
    const rows = await db.listCooldowns();
    const next: Record<string, string> = {};
    for (const r of rows) next[r.model] = r.cooldown_until;
    cooldowns = next;
    lastLoadAt = now;
  } catch { /* backend chưa init */ }
}

function isAvailable(model: string): boolean {
  const until = cooldowns[model];
  if (!until) return true;
  return until <= new Date().toISOString();
}

/**
 * Pick model đầu tiên khả dụng theo priority list.
 * @param tier "agentic" | "text"
 * @param hint complexity (agentic) hoặc role (text)
 * @returns model name; throw nếu tất cả đều cooldown
 */
export async function pickModel(tier: Tier, hint: ComplexityClass | TextRole, opts: { exclude?: string[] } = {}): Promise<string> {
  await loadCooldowns();
  const priority = tier === "agentic"
    ? AGENTIC_PRIORITY[hint as ComplexityClass]
    : TEXT_PRIORITY[hint as TextRole];
  if (!priority) throw new Error(`unknown hint '${hint}' for tier '${tier}'`);
  const excluded = new Set(opts.exclude ?? []);
  for (const model of priority) {
    if (excluded.has(model)) continue;
    if (isAvailable(model)) return model;
  }
  const earliestReset = priority
    .filter(m => !excluded.has(m))
    .map(m => cooldowns[m])
    .filter(Boolean)
    .sort()[0] ?? new Date(Date.now() + 3600_000).toISOString();
  throw Object.assign(new Error(`all models in ${tier}/${hint} are cooling down; earliest reset ${earliestReset}`), { code: "ALL_COOLDOWN", earliestReset });
}

export async function markCooldown(model: string, until: string, reason: string): Promise<void> {
  cooldowns[model] = until;
  try { await db.setModelCooldown(model, until, reason); } catch {}
}

export async function clearCooldown(model: string): Promise<void> {
  delete cooldowns[model];
  try { await db.clearModelCooldown(model); } catch {}
}

export function getCooldowns(): Record<string, string> {
  return { ...cooldowns };
}

// Ước tính USD cost cho 1 session dựa trên model + input/output tokens giả định.
// Dùng để log cảnh báo cho user trước khi Build heavy.
export function estimateCost(model: string, avgInputTokens = 3000, avgOutputTokens = 2000): number {
  const meta = MODELS[model];
  if (!meta) return 0;
  return (avgInputTokens * meta.cost_in + avgOutputTokens * meta.cost_out) / 1_000_000;
}

// Complexity từ CEO rating.
export function complexityFromRating(rating: number | null | undefined): ComplexityClass {
  if (!rating) return "simple";
  if (rating >= 4) return "complex";
  if (rating >= 2) return "medium";
  return "simple";
}

// Force reload cooldowns from DB (useful on worker start).
export async function refreshCooldowns(): Promise<void> {
  await loadCooldowns(true);
}
