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

const env = (k: string, d = "") => process.env[k] ?? d;
const bool = (k: string, d = false) => (process.env[k] ?? String(d)) === "true";

const CFG = {
  niches: env("NICHES", "developer tools,productivity,AI/LLM apps,data viz").split(",").map((s) => s.trim()),
  useRealOllama: bool("USE_REAL_OLLAMA", false),
  ollamaUrl: env("OLLAMA_URL", "http://localhost:11434"),
  ollamaModel: env("MODEL_GATHERER", env("OLLAMA_MODEL", "qwen3:8b")),
  backlogDir: env("BACKLOG_DIR", "./backlog"),
  phToken: env("PH_TOKEN"), // Product Hunt API token (trống = bỏ qua)
  ghLang: env("GITHUB_TRENDING_LANG", ""), // vd "typescript"; trống = mọi ngôn ngữ
  ghSince: env("GITHUB_TRENDING_SINCE", "daily"),
};

export type ProjectType = "web-frontend" | "full-stack" | "cli" | "browser-extension";
export type Idea = { title: string; slug: string; type: ProjectType; pitch: string; why: string; source: string };
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

async function callLLM(prompt: string): Promise<string> {
  const res = await fetch(`${CFG.ollamaUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: CFG.ollamaModel, prompt, stream: false }),
  });
  return (await res.json()).response;
}

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
  pitch: "Snapshot toàn bộ tab đang mở thành 1 list chia sẻ được, lưu local.",
  why: "Nhỏ, dùng ngay, không cần backend — fallback khi mọi nguồn offline.",
  source: "seed",
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
  // Bước 1: lọc theo niche (heuristic) + cắt top 2n để chuyển LLM (nếu bật)
  const shortlist = all
    .map((c) => ({ c, heur: nicheScore(c) }))
    .sort((a, b) => b.heur - a.heur)
    .slice(0, Math.max(n * 2, 12));

  // Bước 2: convert → Idea (heuristic fallback hoặc Ollama batch score)
  const candidates: ScoredIdea[] = shortlist.map(({ c, heur }) => ({
    title: c.title.split("/").pop() ?? c.title,
    slug: slugify(c.title.split("/").pop() ?? c.title),
    type: inferType(c),
    pitch: c.summary,
    why: `Đang trending trên ${c.source}; khớp ngách của bạn.`,
    source: c.source,
    url: c.url,
    score: Math.min(1, heur / 8), // heuristic 0..8 → 0..1
  }));

  // Bước 3: nếu Ollama bật → re-score qua LLM cho top-2n
  if (CFG.useRealOllama) {
    try {
      const prompt = `Bạn là "Prototyper". Với mỗi candidate dưới, chấm điểm 0..1 độ phù hợp build-trong-1-ngày
phục vụ ngách: ${CFG.niches.join(", ")}. Cao = ý tưởng cụ thể, scope nhỏ, có giá trị thực.

${candidates.map((c, i) => `${i + 1}. ${c.title} — ${c.pitch}`).join("\n")}

Chỉ trả về JSON array đúng độ dài, không gì khác:
[{"i":1,"score":0.0..1.0},{"i":2,"score":0.0..1.0},...]`;
      const raw = await callLLM(prompt);
      const m = raw.match(/\[[\s\S]*\]/);
      if (m) {
        const scores: Array<{ i: number; score: number }> = JSON.parse(m[0]);
        for (const s of scores) {
          if (candidates[s.i - 1]) candidates[s.i - 1].score = Math.max(0, Math.min(1, s.score));
        }
      }
    } catch (e: any) {
      log(`   (Ollama scoring lỗi: ${e?.message ?? e} → giữ heuristic score)`);
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

  // Dùng LLM local chọn + định dạng (nếu bật). Có thể tự sáng tạo ý mới từ tín hiệu.
  if (CFG.useRealOllama) {
    const prompt = `Bạn là "Prototyper". Dưới đây là tín hiệu xu hướng hôm nay (ngách quan tâm: ${CFG.niches.join(
      ", "
    )}):
${shortlist.map((c, i) => `${i + 1}. [${c.source}] ${c.title} — ${c.summary}`).join("\n")}

Hãy đề xuất 1 ý tưởng app/web build được trong 1 ngày — có thể lấy cảm hứng từ list trên hoặc tự sáng tạo.
Chỉ trả về JSON, không gì khác:
{"title":"...","slug":"...","type":"web-frontend|full-stack|cli|browser-extension","pitch":"1 câu","why":"vì sao đáng làm","source":"nguồn cảm hứng"}`;
    try {
      const idea = extractJson(await callLLM(prompt)) as Idea;
      if (idea.title && idea.type) {
        idea.slug = slugify(idea.slug || idea.title);
        return idea;
      }
    } catch {
      log("   (LLM lỗi/parse fail → chọn theo điểm ngách)");
    }
  }

  // Fallback xác định: lấy ứng viên điểm cao nhất, suy ra loại
  const top = shortlist[0];
  return {
    title: top.title.split("/").pop() ?? top.title,
    slug: slugify(top.title.split("/").pop() ?? top.title),
    type: inferType(top),
    pitch: top.summary,
    why: `Đang trending trên ${top.source}; khớp ngách của bạn.`,
    source: top.source,
  };
}

// ===================== CHẠY ĐỘC LẬP ===============================
if (import.meta.main) {
  const idea = await collectIdea();
  log("\n🏆 Ý tưởng được chọn:");
  log(JSON.stringify(idea, null, 2));
}
