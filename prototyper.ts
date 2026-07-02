/**
 * prototyper.ts — Vai "Prototyper": người thu thập ý tưởng, nuôi pipeline.
 *
 * Gom ý tưởng từ 4 nguồn (Hacker News + GitHub Trending + Product Hunt + backlog của bạn),
 * lọc/ưu tiên theo ngách, rồi chọn ra 1 ý tưởng tốt nhất build-được-trong-1-ngày.
 * gstack không có vai này — đây là mảnh custom đứng đầu hệ thống.
 *
 * Chạy độc lập để xem hôm nay gom được gì:
 *   bun run prototyper.ts
 * Hoặc được mirotic.ts import: collectIdea() trả về 1 Idea cho pipeline.
 */

import { callLLM, isClaude, isGemini, isGpt } from "./llm";
import * as registry from "./model-registry";

const env = (k: string, d = "") => process.env[k] ?? d;
const bool = (k: string, d = false) => (process.env[k] ?? String(d)) === "true";

const CFG = {
  niches: env("NICHES", "developer tools,productivity,AI/LLM apps,data viz").split(",").map((s) => s.trim()),
  gathererModel: env("MODEL_GATHERER", env("OLLAMA_MODEL", "claude-haiku-4-5-20251001")),
  // Ollama vẫn cần USE_REAL_OLLAMA để bật; Claude tự bật (auth qua Max/API key).
  useRealOllama: bool("USE_REAL_OLLAMA", false),
  backlogDir: env("BACKLOG_DIR", "./backlog"),
  phToken: env("PH_TOKEN"), // Product Hunt API token (trống = bỏ qua)
  ghLang: env("GITHUB_TRENDING_LANG", ""), // vd "typescript"; trống = mọi ngôn ngữ
  ghSince: env("GITHUB_TRENDING_SINCE", "daily"),
};
// Prototyper dùng LLM khi: Claude / Gemini / GPT có sẵn auth, HOẶC Ollama + USE_REAL_OLLAMA=true.
const useLLMEnrich = isClaude(CFG.gathererModel) || isGemini(CFG.gathererModel) || isGpt(CFG.gathererModel) || CFG.useRealOllama;

export type ProjectType = "web-frontend" | "full-stack" | "cli" | "browser-extension";
export type Idea = {
  title: string; slug: string; type: ProjectType;
  pitch: string; why: string; source: string;
  // Song ngữ (title + pitch: Ollama dịch; why: Prototyper heuristic 2 ngôn ngữ).
  title_vi?: string; pitch_vi?: string; why_vi?: string;
  title_en?: string; pitch_en?: string; why_en?: string;
  // Brief chi tiết (Ollama enrich trong batch call).
  features?: string[]; features_vi?: string[]; features_en?: string[];
  target_user?: string; target_user_vi?: string; target_user_en?: string;
  demo_hours?: number;                    // ước lượng giờ build demo (2..24)
  why_now?: string; why_now_vi?: string; why_now_en?: string;
  risk?: string; risk_vi?: string; risk_en?: string;
};
type Candidate = { title: string; summary: string; source: string; url?: string };

const log = (s = "") => console.log(s);
const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "idea";

// ============================ NGUỒN ===============================

// Hacker News — Firebase API (miễn phí, không cần key)
async function fromHN(limit = 10): Promise<Candidate[]> {
  try {
    const ids: number[] = await (await fetch("https://hacker-news.firebaseio.com/v0/topstories.json")).json();
    const items = await Promise.all(
      ids.slice(0, limit).map((id) =>
        fetch(`https://hacker-news.firebaseio.com/v0/item/${id}.json`).then((r) => r.json())
      )
    );
    return items
      .filter((it) => it?.title)
      .map((it) => ({
        title: it.title,
        summary: `HN ${it.score ?? 0}↑ · ${it.descendants ?? 0} bình luận`,
        source: "Hacker News",
        url: it.url || `https://news.ycombinator.com/item?id=${it.id}`,
      }));
  } catch {
    return [];
  }
}

// GitHub Trending — không có API chính thức, parse trang /trending
async function fromGitHubTrending(limit = 10): Promise<Candidate[]> {
  try {
    const url = `https://github.com/trending${CFG.ghLang ? "/" + CFG.ghLang : ""}?since=${CFG.ghSince}`;
    const htmlText = await (await fetch(url, { headers: { "User-Agent": "mirotic-prototyper" } })).text();
    const rows = htmlText.split('class="Box-row"').slice(1);
    return rows
      .slice(0, limit)
      .map((row) => {
        const repo = (row.match(/<h2[^>]*>[\s\S]*?href="\/([^"]+)"/)?.[1] ?? "").split("?")[0].trim();
        const descMatch = row.match(/<p[^>]*col-9[^>]*>([\s\S]*?)<\/p>/);
        const summary = descMatch ? descMatch[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() : "";
        return { title: repo, summary: summary || "(no description)", source: "GitHub Trending", url: `https://github.com/${repo}` };
      })
      .filter((c) => c.title.includes("/"));
  } catch {
    return [];
  }
}

// Product Hunt — GraphQL API v2 (cần token; bỏ qua nếu trống)
async function fromProductHunt(limit = 10): Promise<Candidate[]> {
  if (!CFG.phToken) return [];
  try {
    const query = `{ posts(first: ${limit}, order: VOTES) { edges { node { name tagline url } } } }`;
    const res = await fetch("https://api.producthunt.com/v2/api/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${CFG.phToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    return (data?.data?.posts?.edges ?? []).map((e: any) => ({
      title: e.node.name,
      summary: e.node.tagline,
      source: "Product Hunt",
      url: e.node.url,
    }));
  } catch {
    return [];
  }
}

// Backlog của bạn — đọc file .md/.txt mounted vào, mỗi dòng/bullet = 1 ý tưởng tiềm năng
async function fromBacklog(): Promise<Candidate[]> {
  try {
    const { readdirSync, readFileSync } = await import("node:fs");
    const out: Candidate[] = [];
    for (const f of readdirSync(CFG.backlogDir).filter((f) => /\.(md|txt)$/i.test(f))) {
      const content = readFileSync(`${CFG.backlogDir}/${f}`, "utf8");
      for (const raw of content.split("\n")) {
        const t = raw.replace(/^[-*#>\d.\s]+/, "").trim();
        if (t.length > 8) out.push({ title: t, summary: "từ backlog của bạn", source: `backlog/${f}` });
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ===================== XẾP HẠNG + CHỌN ============================

// Điểm liên quan ngách: đếm từ khoá ngách xuất hiện + ưu tiên nhẹ theo nguồn
function nicheScore(c: Candidate): number {
  const text = `${c.title} ${c.summary}`.toLowerCase();
  let s = CFG.niches.reduce((n, kw) => n + (text.includes(kw.toLowerCase()) ? 2 : 0), 0);
  if (c.source === "backlog") s += 1; // ý tưởng của chính bạn được cộng điểm
  return s;
}

function inferType(c: Candidate): ProjectType {
  const t = `${c.title} ${c.summary}`.toLowerCase();
  if (/(cli|command.?line|terminal|\bshell\b)/.test(t)) return "cli";
  if (/(extension|chrome|firefox|browser add)/.test(t)) return "browser-extension";
  if (/(api|backend|database|\bauth\b|server|postgres|supabase)/.test(t)) return "full-stack";
  return "web-frontend";
}

// Prototyper synthesis routed qua text-tier registry, role='gatherer', auto-fallback.
// Gemini flash cần thinkingBudget=-1 (High/dynamic) cho creativity — inject nếu model là flash.
const callLLMForGather = async (prompt: string, opts: { num_predict?: number } = {}): Promise<string> => {
  const tried: string[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    let model: string;
    try { model = await registry.pickModel("text", "gatherer"); }
    catch (e: any) {
      throw new Error(`Gatherer: all text models cooling down; earliest reset ${e.earliestReset}`);
    }
    if (tried.includes(model)) throw new Error(`Gatherer: router exhausted (tried ${tried.join(", ")})`);
    tried.push(model);
    try {
      const out = await callLLM(model, prompt, {
        num_predict: opts.num_predict, timeoutMs: 180_000,
        thinkingBudget: /gemini-.*flash/i.test(model) ? -1 : undefined,
      });
      log(`   ✓ Gatherer via ${model}`);
      return out;
    } catch (e: any) {
      log(`   ✗ Gatherer ${model}: ${e?.message?.slice(0, 100) ?? e}, thử fallback`);
      const errMsg = String(e?.message ?? e);
      // Nếu là rate-limit signal → mark cooldown (parseRateLimitReset không import ở đây, dùng regex đơn giản)
      const m = errMsg.match(/reset(?:s| at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
      if (m || /session limit|usage limit|429|rate.?limit/i.test(errMsg)) {
        // Đơn giản: đánh dấu cooldown 1h
        await registry.markCooldown(model, new Date(Date.now() + 3600_000).toISOString(), "gatherer hit limit");
      }
    }
  }
  throw new Error(`Gatherer: exhausted after ${tried.join(", ")}`);
};

function extractJson(s: string): any {
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b < 0) throw new Error("no json");
  return JSON.parse(s.slice(a, b + 1));
}

const SEED: Idea = {
  title: "TabStash",
  slug: "tabstash",
  type: "web-frontend",
  pitch: "Snapshot all open tabs into 1 shareable list, stored local.",
  why: "Small, immediately usable, no backend — fallback when all sources are offline.",
  source: "seed",
  title_vi: "TabStash",
  pitch_vi: "Snapshot toàn bộ tab đang mở thành 1 list chia sẻ được, lưu local.",
  why_vi: "Nhỏ, dùng ngay, không cần backend — fallback khi mọi nguồn offline.",
  title_en: "TabStash",
  pitch_en: "Snapshot all open tabs into 1 shareable list, stored local.",
  why_en: "Small, immediately usable, no backend — fallback when all sources are offline.",
};

export type ScoredIdea = Idea & { score: number; url?: string };

/**
 * Batch collect: gom nhiều ý tưởng + score (Ollama nếu bật, không thì heuristic).
 * Trả về N ý tưởng sắp xếp theo score desc.
 * Caller (mirotic daemon) tự quyết: top-K → jobs(proposed), còn lại → idea_pool.
 */
export async function batchCollect(n = 10): Promise<ScoredIdea[]> {
  const [hn, gh, ph, bl] = await Promise.all([fromHN(), fromGitHubTrending(), fromProductHunt(), fromBacklog()]);
  log(`🔎 Signals: HN ${hn.length} · GitHub ${gh.length} · PH ${ph.length} · backlog ${bl.length}`);
  const all = [...hn, ...gh, ...ph, ...bl];
  if (all.length === 0) {
    log("   (không gom được signals → dùng seed)");
    return [{ ...SEED, score: 0.5 }];
  }
  // Top ~20 signals theo niche score làm INSPIRATION (không phải candidates để copy).
  const inspirations = all
    .map((c) => ({ c, heur: nicheScore(c) }))
    .sort((a, b) => b.heur - a.heur)
    .slice(0, 20)
    .map((x) => x.c);

  // LLM synthesize N idea GỐC dựa vào signals (Opus 4.7 default — creative).
  if (useLLMEnrich) {
    try {
      const prompt = `Bạn là "Prototyper" — founder solo đang tìm ${n} idea "buildable trong 1 ngày" mỗi sáng.

Niche founder quan tâm: ${CFG.niches.join(", ")}

Tín hiệu xu hướng hôm nay (CHỈ LÀ INSPIRATION — không copy trực tiếp):
${inspirations.map((c, i) => `${i + 1}. [${c.source}] ${c.title} — ${c.summary}`).join("\n")}

Nhiệm vụ: sinh ra ${n} idea GỐC. Có thể:
- Lấy 1 signal, reframe / kết hợp / đối lập / thu hẹp scope xuống 1 ngách
- Nhìn signal, thấy "pain thực" đằng sau, đề xuất tool nhỏ giải cứu
- Tự sáng tạo không dựa vào signal nào — nếu bạn thấy có ý hay hơn

TIÊU CHÍ CHẤT LƯỢNG (quan trọng — tránh idea "chán"):
- **Cụ thể**: title phải là tên product, KHÔNG phải mô tả generic ("AI Todo Wrapper" ❌, "Standup — 5-min voice memo → team digest" ✓)
- **Có góc riêng**: nêu rõ 1 điểm khác biệt với các tool cùng lĩnh vực đã có
- **Buildable 1 ngày**: 2-24h, KHÔNG cần API/data khó xin, KHÔNG scope > 1 người 1 ngày
- **Target user cụ thể**: "developers debugging..." ❌ vague; "SREs chăm 3 microservices Go, không muốn attach debugger" ✓
- **PMF signal**: user có động lực trả tiền / khoe cho bạn / dùng weekly?
- **Đa dạng**: 10 idea đừng cùng 1 lĩnh vực. Trải: dev tools, productivity, AI/LLM apps, data viz, creative tools...

Song ngữ EN + VI cho mọi text. type ∈ web-frontend | full-stack | cli | browser-extension.
Trả JSON array ${n} items, không markdown, không giải thích:
[{"title_en":"...","title_vi":"...","slug":"kebab-case-slug","type":"web-frontend",
"pitch_en":"1 câu tagline","pitch_vi":"...",
"features_en":["3-5 bullet feature core"],"features_vi":["..."],
"target_user_en":"1 câu ai dùng","target_user_vi":"...",
"why_now_en":"1 câu vì sao lúc này","why_now_vi":"...",
"risk_en":"1 câu rủi ro/giả định lớn nhất","risk_vi":"...",
"demo_hours":6,
"source":"insp: HN 'X' (reframe as Y)  |  original"},...]`;
      const raw = await callLLMForGather(prompt, { num_predict: 65536 });
      const m = raw.match(/\[[\s\S]*\]/);
      if (m) {
        const items = JSON.parse(m[0]) as any[];
        const synthesized: ScoredIdea[] = items.slice(0, n).map((it) => {
          const titleEn = String(it.title_en ?? it.title ?? "Untitled");
          const t: ProjectType = (["web-frontend", "full-stack", "cli", "browser-extension"].includes(it.type)
            ? it.type : "web-frontend") as ProjectType;
          return {
            title: titleEn,
            slug: slugify(String(it.slug ?? titleEn)),
            type: t,
            pitch: String(it.pitch_en ?? it.pitch ?? ""),
            why: String(it.why_now_vi ?? it.why_now_en ?? "Prototyper đề xuất."),
            source: String(it.source ?? "prototyper"),
            score: 0.7,                            // score sẽ do CEO review overwrite
            title_en: titleEn, title_vi: it.title_vi ?? titleEn,
            pitch_en: String(it.pitch_en ?? ""), pitch_vi: String(it.pitch_vi ?? ""),
            why_en: String(it.why_now_en ?? ""), why_vi: String(it.why_now_vi ?? ""),
            features_en: Array.isArray(it.features_en) ? it.features_en.slice(0, 5).map(String) : undefined,
            features_vi: Array.isArray(it.features_vi) ? it.features_vi.slice(0, 5).map(String) : undefined,
            target_user_en: it.target_user_en ? String(it.target_user_en) : undefined,
            target_user_vi: it.target_user_vi ? String(it.target_user_vi) : undefined,
            why_now_en: it.why_now_en ? String(it.why_now_en) : undefined,
            why_now_vi: it.why_now_vi ? String(it.why_now_vi) : undefined,
            risk_en: it.risk_en ? String(it.risk_en) : undefined,
            risk_vi: it.risk_vi ? String(it.risk_vi) : undefined,
            demo_hours: typeof it.demo_hours === "number" ? Math.max(1, Math.min(24, Math.round(it.demo_hours))) : undefined,
          };
        });
        log(`   ✓ Prototyper synthesize ${synthesized.length} ideas (model: ${CFG.gathererModel})`);
        return synthesized;
      }
      log(`   (LLM output không parse được JSON array → fallback heuristic)`);
    } catch (e: any) {
      log(`   (Prototyper synthesis lỗi (${CFG.gathererModel}): ${e?.message ?? e} → fallback heuristic)`);
    }
  }

  // Fallback heuristic: rank raw candidates by niche, dùng trực tiếp làm idea (chán như cũ, nhưng vẫn có gì đó).
  return inspirations.slice(0, n).map((c) => {
    const rawTitle = c.title.split("/").pop() ?? c.title;
    return {
      title: rawTitle, slug: slugify(rawTitle), type: inferType(c),
      pitch: c.summary, why: `Đang trending trên ${c.source}; khớp ngách của bạn.`,
      source: c.source, url: c.url, score: 0.3,
      title_en: rawTitle, title_vi: rawTitle,
      pitch_en: c.summary, pitch_vi: c.summary,
      why_en: `Trending on ${c.source}.`, why_vi: `Đang trending trên ${c.source}.`,
    };
  });
}

/** Thu thập từ mọi nguồn, lọc theo ngách, chọn 1 ý tưởng. */
export async function collectIdea(): Promise<Idea> {
  const [hn, gh, ph, bl] = await Promise.all([fromHN(), fromGitHubTrending(), fromProductHunt(), fromBacklog()]);
  log(`🔎 Prototyper gom: HN ${hn.length} · GitHub ${gh.length} · ProductHunt ${ph.length} · backlog ${bl.length}`);

  const all = [...hn, ...gh, ...ph, ...bl];
  if (all.length === 0) {
    log("   (không gom được nguồn nào → dùng seed)");
    return SEED;
  }

  const shortlist = all.sort((a, b) => nicheScore(b) - nicheScore(a)).slice(0, 12);

  // Dùng LLM chọn + định dạng + song ngữ (nếu bật). Có thể tự sáng tạo ý mới từ tín hiệu.
  if (useLLMEnrich) {
    const prompt = `Bạn là "Prototyper". Dưới đây là tín hiệu xu hướng hôm nay (ngách quan tâm: ${CFG.niches.join(", ")}):
${shortlist.map((c, i) => `${i + 1}. [${c.source}] ${c.title} — ${c.summary}`).join("\n")}

Hãy đề xuất 1 ý tưởng app/web build được trong 1 ngày — có thể lấy cảm hứng từ list trên hoặc tự sáng tạo.
Cần song ngữ (EN + VI). Chỉ trả về JSON, không gì khác:
{"title":"EN","title_vi":"VN","slug":"...","type":"web-frontend|full-stack|cli|browser-extension","pitch":"EN","pitch_vi":"VN","why":"EN","why_vi":"VN","source":"nguồn cảm hứng"}`;
    try {
      const idea = extractJson(await callLLMForGather(prompt)) as Idea;
      if (idea.title && idea.type) {
        idea.slug = slugify(idea.slug || idea.title);
        idea.title_en = idea.title_en ?? idea.title;
        idea.pitch_en = idea.pitch_en ?? idea.pitch;
        idea.why_en = idea.why_en ?? idea.why;
        return idea;
      }
    } catch {
      log("   (LLM lỗi/parse fail → chọn theo điểm ngách)");
    }
  }

  // Fallback xác định: lấy ứng viên điểm cao nhất, suy ra loại. Song ngữ bằng heuristic đơn giản.
  const top = shortlist[0];
  const rawTitle = top.title.split("/").pop() ?? top.title;
  return {
    title: rawTitle,
    slug: slugify(rawTitle),
    type: inferType(top),
    pitch: top.summary,
    why: `Đang trending trên ${top.source}; khớp ngách của bạn.`,
    source: top.source,
    title_vi: rawTitle, pitch_vi: top.summary,
    why_vi: `Đang trending trên ${top.source}; khớp ngách của bạn.`,
    title_en: rawTitle, pitch_en: top.summary,
    why_en: `Trending on ${top.source}; matches your niche.`,
  };
}

// ===================== CHẠY ĐỘC LẬP ===============================
if (import.meta.main) {
  const idea = await collectIdea();
  log("\n🏆 Ý tưởng được chọn:");
  log(JSON.stringify(idea, null, 2));
}
