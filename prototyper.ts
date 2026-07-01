/**
 * prototyper.ts — Vai "Prototyper": người thu thập ý tưởng, nuôi pipeline.
 *
 * Gom ý tưởng từ 4 nguồn (Hacker News + GitHub Trending + Product Hunt + backlog của bạn),
 * lọc/ưu tiên theo ngách, rồi chọn ra 1 ý tưởng tốt nhất build-được-trong-1-ngày.
 * gstack không có vai này — đây là mảnh custom đứng đầu hệ thống.
 *
 * Chạy độc lập để xem hôm nay gom được gì:
 *   bun run prototyper.ts
 * Hoặc được daily-loop.ts import: collectIdea() trả về 1 Idea cho pipeline.
 */

import { callLLM, isClaude } from "./llm";

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
// Prototyper dùng LLM để enrich khi: model là Claude, HOẶC Ollama + USE_REAL_OLLAMA=true.
const useLLMEnrich = isClaude(CFG.gathererModel) || CFG.useRealOllama;

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
    const htmlText = await (await fetch(url, { headers: { "User-Agent": "daily-loop-prototyper" } })).text();
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

// Wrapper mini: prompt qua router — model tuỳ CFG.gathererModel (Claude hoặc Ollama).
const callLLMForGather = (prompt: string, opts: { num_predict?: number } = {}) =>
  callLLM(CFG.gathererModel, prompt, { num_predict: opts.num_predict, timeoutMs: 180_000 });

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
 * Caller (daily-loop daemon) tự quyết: top-K → jobs(proposed), còn lại → idea_pool.
 */
export async function batchCollect(n = 10): Promise<ScoredIdea[]> {
  const [hn, gh, ph, bl] = await Promise.all([fromHN(), fromGitHubTrending(), fromProductHunt(), fromBacklog()]);
  log(`🔎 Prototyper gom: HN ${hn.length} · GitHub ${gh.length} · ProductHunt ${ph.length} · backlog ${bl.length}`);
  const all = [...hn, ...gh, ...ph, ...bl];
  if (all.length === 0) {
    log("   (không gom được nguồn nào → dùng seed)");
    return [{ ...SEED, score: 0.5 }];
  }
  // Bước 1: lọc theo niche (heuristic). Chỉ giữ n+2 để Ollama re-rank + translate (giữ output ngắn).
  const shortlist = all
    .map((c) => ({ c, heur: nicheScore(c) }))
    .sort((a, b) => b.heur - a.heur)
    .slice(0, n + 2);

  // Bước 2: convert → Idea (heuristic fallback hoặc Ollama batch score+translate)
  const candidates: ScoredIdea[] = shortlist.map(({ c, heur }) => {
    const rawTitle = c.title.split("/").pop() ?? c.title;
    const whyEn = `Trending on ${c.source}; matches your niche.`;
    const whyVi = `Đang trending trên ${c.source}; khớp ngách của bạn.`;
    return {
      title: rawTitle,
      slug: slugify(rawTitle),
      type: inferType(c),
      pitch: c.summary,
      why: whyVi,
      source: c.source,
      url: c.url,
      score: Math.min(1, heur / 8),
      // Fallback: giữ nguyên gốc cho cả 2 ngôn ngữ; Ollama sẽ override title_vi + pitch_vi.
      title_en: rawTitle,
      pitch_en: c.summary,
      why_en: whyEn,
      title_vi: rawTitle,
      pitch_vi: c.summary,
      why_vi: whyVi,
    };
  });

  // Bước 3: LLM batch enrich — score + translate + full brief trong 1 shot.
  if (useLLMEnrich) {
    try {
      const prompt = `Bạn là "Prototyper". Với mỗi candidate dưới, enrich thành brief đầy đủ.

Niche: ${CFG.niches.join(", ")}

Task cho MỖI candidate:
1. score (0..1): độ phù hợp build-trong-1-ngày. Cao = scope rõ, giá trị thực, không cần API xa lạ.
2. Song ngữ EN + VI cho: title, pitch, features (3-5 bullets ngắn), target_user, why_now (1 câu lý do timing), risk (1 câu rủi ro/giả định lớn nhất).
3. demo_hours: số nguyên 2..24 ước lượng giờ build demo MVP.

Candidates:
${candidates.map((c, i) => `${i + 1}. ${c.title} — ${c.pitch}`).join("\n")}

Chỉ trả JSON array, không markdown, không giải thích:
[{"i":1,"score":0.85,"demo_hours":6,
"title_en":"...","title_vi":"...",
"pitch_en":"...","pitch_vi":"...",
"features_en":["...","...","..."],"features_vi":["...","...","..."],
"target_user_en":"...","target_user_vi":"...",
"why_now_en":"...","why_now_vi":"...",
"risk_en":"...","risk_vi":"..."},...]`;
      const raw = await callLLMForGather(prompt, { num_predict: 16384 });
      const m = raw.match(/\[[\s\S]*\]/);
      if (m) {
        const items: Array<any> = JSON.parse(m[0]);
        for (const s of items) {
          const c = candidates[s.i - 1];
          if (!c) continue;
          if (typeof s.score === "number") c.score = Math.max(0, Math.min(1, s.score));
          if (typeof s.demo_hours === "number") c.demo_hours = Math.max(1, Math.min(24, Math.round(s.demo_hours)));
          for (const k of ["title", "pitch", "target_user", "why_now", "risk"]) {
            if (s[`${k}_en`]) (c as any)[`${k}_en`] = s[`${k}_en`];
            if (s[`${k}_vi`]) (c as any)[`${k}_vi`] = s[`${k}_vi`];
          }
          if (Array.isArray(s.features_en)) c.features_en = s.features_en.slice(0, 5).map(String);
          if (Array.isArray(s.features_vi)) c.features_vi = s.features_vi.slice(0, 5).map(String);
        }
      }
    } catch (e: any) {
      log(`   (LLM enrich lỗi (${CFG.gathererModel}): ${e?.message ?? e} → giữ heuristic brief)`);
    }
  }

  return candidates.sort((a, b) => b.score - a.score).slice(0, n);
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
