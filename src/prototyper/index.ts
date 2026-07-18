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

import { callLLM, isClaude, isGemini, isGpt } from "../llm";
import * as registry from "../llm/registry";
import type { Idea, ProjectType, ScoredIdea } from "../types";
export type { Idea, ProjectType, ScoredIdea } from "../types";

const env = (k: string, d = "") => process.env[k] ?? d;
const bool = (k: string, d = false) => (process.env[k] ?? String(d)) === "true";

const CFG = {
  niches: env("NICHES", "developer tools,productivity,AI/LLM apps,data viz,everyday life,personal finance,health & sleep,cooking & groceries,commuting & travel,family & relationships").split(",").map((s) => s.trim()),
  prototyperModel: env("MODEL_PROTOTYPER", env("OLLAMA_MODEL", "claude-sonnet-5")),
  // Ollama vẫn cần USE_REAL_OLLAMA để bật; Claude tự bật (auth qua Max/API key).
  useRealOllama: bool("USE_REAL_OLLAMA", false),
  backlogDir: env("BACKLOG_DIR", "./backlog"),
  phToken: env("PH_TOKEN"), // Product Hunt API token (trống = bỏ qua)
  ghLang: env("GITHUB_TRENDING_LANG", ""), // vd "typescript"; trống = mọi ngôn ngữ
  ghSince: env("GITHUB_TRENDING_SINCE", "daily"),
};
// Prototyper dùng LLM khi: Claude / Gemini / GPT có sẵn auth, HOẶC Ollama + USE_REAL_OLLAMA=true.
const useLLMEnrich = isClaude(CFG.prototyperModel) || isGemini(CFG.prototyperModel) || isGpt(CFG.prototyperModel) || CFG.useRealOllama;

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

// Prototyper synthesis routed qua text-tier registry, role='prototyper', auto-fallback.
// Gemini flash cần thinkingBudget=-1 (High/dynamic) cho creativity — inject nếu model là flash.
const callLLMForPrototyper = async (prompt: string, opts: { num_predict?: number } = {}): Promise<string> => {
  const tried: string[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    let model: string;
    try { model = await registry.pickModel("text", "prototyper", { exclude: tried }); }
    catch (e: any) {
      throw new Error(`Prototyper: all text models cooling down or exhausted; earliest reset ${e.earliestReset}`);
    }
    tried.push(model);
    try {
      const out = await callLLM(model, prompt, {
        num_predict: opts.num_predict, timeoutMs: 180_000,
        thinkingBudget: /gemini-.*flash/i.test(model) ? -1 : undefined,
      });
      log(`   ✓ Prototyper via ${model}`);
      return out;
    } catch (e: any) {
      log(`   ✗ Prototyper ${model}: ${e?.message?.slice(0, 100) ?? e}, thử fallback`);
      const errMsg = String(e?.message ?? e);
      const m = errMsg.match(/reset(?:s| at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
      if (m || /session limit|usage limit|429|rate.?limit/i.test(errMsg)) {
        // Chỉ mark cooldown khi thực sự rate-limit — cooldown chia sẻ DB giữa worker/container.
        await registry.markCooldown(model, new Date(Date.now() + 3600_000).toISOString(), "prototyper hit limit");
      }
      // Runtime CLI thiếu (container không có claude/codex) — không mark cooldown (worker vẫn dùng được),
      // chỉ ghi tried[] để loop lấy model kế tiếp qua opts.exclude.
    }
  }
  throw new Error(`Prototyper: exhausted after ${tried.join(", ")}`);
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

/**
 * Batch collect: gom nhiều ý tưởng + score (Ollama nếu bật, không thì heuristic).
 * Trả về N ý tưởng sắp xếp theo score desc.
 * Caller (mirotic daemon) tự quyết: top-K → jobs(proposed), còn lại → idea_pool.
 */
// Normalize title để so trùng: lowercase, bỏ ký tự đặc biệt.
const normTitle = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

export async function batchCollect(n = 10, existing: Array<{ title: string; pitch: string }> = []): Promise<ScoredIdea[]> {
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
${existing.length ? `
⛔ IDEA ĐÃ CÓ TRONG PIPELINE — TUYỆT ĐỐI KHÔNG đề xuất lại, KHÔNG đề xuất biến thể gần (đổi tên nhưng cùng mechanic/cùng pain):
${existing.slice(0, 60).map((e) => `- ${e.title}: ${e.pitch.slice(0, 80)}`).join("\n")}
Nếu 1 idea của bạn giải cùng pain với item trên → phải có mechanic KHÁC HẲN, nếu không thì bỏ, nghĩ idea khác.
` : ""}
Nhiệm vụ: sinh ra ${n} idea GỐC. Có thể:
- Lấy 1 signal, reframe / kết hợp / đối lập / thu hẹp scope xuống 1 ngách
- Nhìn signal, thấy "pain thực" đằng sau, đề xuất tool nhỏ giải cứu
- Quan sát trực tiếp cuộc sống hằng ngày (nội trợ, đi chợ, chăm con, di chuyển, sức khoẻ, tài chính cá nhân...), thấy chỗ đau/lặp lại/khó chịu → tool nhỏ giải cứu
- Tự sáng tạo không dựa vào signal nào — nếu bạn thấy có ý hay hơn

TIÊU CHÍ CHẤT LƯỢNG (quan trọng — tránh idea "chán"):
- **Cụ thể**: title_en/title_vi chỉ là tên product ngắn gọn, KHÔNG kèm em-dash + tagline. Tagline đã có ở pitch_en riêng. Ví dụ: title="Standup" ✓, KHÔNG "Standup — 5-min voice memo" ❌ (redundant với pitch).
- **Có góc riêng**: nêu rõ 1 điểm khác biệt với các tool cùng lĩnh vực đã có
- **Features = hành vi demo được**: mỗi feature là 1 câu "user làm X → thấy Y trên màn hình". KHÔNG marketing claim ("theo dõi thông minh" ❌), KHÔNG khả năng kỹ thuật chưa chứng minh ("dùng mic bắt chuyển động qua nệm" ❌). Ai đọc features phải hình dung được đúng màn hình demo.
- **Buildable 1 ngày**: 2-24h, KHÔNG cần API/data khó xin, KHÔNG scope > 1 người 1 ngày, KHÔNG dựa vào ML/CV/sensor processing chưa có sẵn
- **Target user cụ thể**: "developers debugging..." ❌ vague; "SREs chăm 3 microservices Go, không muốn attach debugger" ✓; "mẹ 2 con lập menu tuần Chủ Nhật" ✓
- **PMF signal**: user có động lực trả tiền / khoe cho bạn / dùng weekly?
- **Cân bằng phạm vi (BẮT BUỘC)**: ${n} idea PHẢI chia rõ hai nhóm — dù prompt/signals nghiêng về tech, VẪN phải giữ tỷ lệ:
    - **~50% "everyday-life"**: giải nỗi đau/task lặp lại trong đời sống thực (đi chợ, nấu ăn, ngủ, sức khoẻ, tài chính cá nhân, giấy tờ, gia đình, di chuyển, mua sắm, học tập nhẹ, sở thích cá nhân). Target user KHÔNG phải dev/founder.
    - **~50% "niche-technical"**: dev tools, productivity, AI/LLM apps, data viz, creative tools cho pro users.
    Trong mỗi nhóm cũng đừng dồn cùng 1 lĩnh vực nhỏ.

Song ngữ EN + VI cho mọi text. type ∈ web-frontend | full-stack | cli | browser-extension | mobile-expo.

**Cân bằng platform (BẮT BUỘC)**: 4-5 idea PHẢI có type="mobile-expo" (React Native + Expo — chạy trên iOS/Android). Còn lại chia đều các type khác.
- Mobile idea tập trung: offline-first, camera/mic/GPS, notifications, portrait UX, on-the-go moment (đang di chuyển / trong bếp / ở phòng gym). KHÔNG mobile version của tool desktop.
- Buildable-1-day cho mobile = feature core + 1-2 screens, không auth phức tạp, không sync cloud.

Trả JSON array ${n} items, không markdown, không giải thích:
[{"title_en":"...","title_vi":"...","slug":"kebab-case-slug","type":"web-frontend|mobile-expo|...",
"pitch_en":"1 câu tagline","pitch_vi":"...",
"features_en":["3-5 bullet feature core"],"features_vi":["..."],
"flow_vi":"3-5 câu tiếng Việt kể user flow end-to-end: mở app → làm gì → thấy gì → giá trị nhận được. Văn kể chuyện, không bullet.","flow_en":"same in English",
"feature_notes_vi":["song song features — mỗi feature 1-2 câu tiếng Việt: vì sao cần, dùng lúc nào"],"feature_notes_en":["same in English"],
"target_user_en":"1 câu ai dùng","target_user_vi":"...",
"why_now_en":"1 câu vì sao lúc này","why_now_vi":"...",
"risk_en":"1 câu rủi ro/giả định lớn nhất","risk_vi":"...",
"demo_hours":6,
"source":"insp: HN 'X' (reframe as Y)  |  original"},...]`;
      const raw = await callLLMForPrototyper(prompt, { num_predict: 65536 });
      const m = raw.match(/\[[\s\S]*\]/);
      if (m) {
        const items = JSON.parse(m[0]) as any[];
        const synthesized: ScoredIdea[] = items.slice(0, n).map((it) => {
          const titleEn = String(it.title_en ?? it.title ?? "Untitled");
          const t: ProjectType = (["web-frontend", "full-stack", "cli", "browser-extension", "mobile-expo"].includes(it.type)
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
            flow_vi: it.flow_vi ? String(it.flow_vi) : undefined,
            flow_en: it.flow_en ? String(it.flow_en) : undefined,
            feature_notes_vi: Array.isArray(it.feature_notes_vi) ? it.feature_notes_vi.slice(0, 5).map(String) : undefined,
            feature_notes_en: Array.isArray(it.feature_notes_en) ? it.feature_notes_en.slice(0, 5).map(String) : undefined,
            target_user_en: it.target_user_en ? String(it.target_user_en) : undefined,
            target_user_vi: it.target_user_vi ? String(it.target_user_vi) : undefined,
            why_now_en: it.why_now_en ? String(it.why_now_en) : undefined,
            why_now_vi: it.why_now_vi ? String(it.why_now_vi) : undefined,
            risk_en: it.risk_en ? String(it.risk_en) : undefined,
            risk_vi: it.risk_vi ? String(it.risk_vi) : undefined,
            demo_hours: typeof it.demo_hours === "number" ? Math.max(1, Math.min(24, Math.round(it.demo_hours))) : undefined,
          };
        });
        // Post-filter: drop idea trùng title với pipeline hiện có hoặc trùng nhau trong batch.
        const seen = new Set(existing.map((e) => normTitle(e.title)));
        const deduped = synthesized.filter((s) => {
          const k = normTitle(s.title);
          if (seen.has(k)) { log(`   ✗ drop duplicate "${s.title}"`); return false; }
          seen.add(k);
          return true;
        });
        log(`   ✓ Prototyper synthesize ${deduped.length} ideas (model: ${CFG.prototyperModel}${deduped.length < synthesized.length ? `, dropped ${synthesized.length - deduped.length} dup` : ""})`);
        return deduped;
      }
      log(`   (LLM output không parse được JSON array → fallback heuristic)`);
    } catch (e: any) {
      log(`   (Prototyper synthesis lỗi (${CFG.prototyperModel}): ${e?.message ?? e} → fallback heuristic)`);
    }
  }

  // Synthesis fail (LLM đã thử 4 model trong callLLMForPrototyper mà vẫn lỗi/không parse được).
  // KHÔNG fallback phun tiêu đề HN/GitHub thô làm "idea" — đó chỉ tạo card rác 1-2⭐ làm bẩn board.
  // Trả rỗng: hôm nay không thêm idea mới, batch mai retry. Board sạch hơn "có gì đó nhưng rác".
  log(`   ⚠️  Prototyper synthesis fail — bỏ qua batch hôm nay (KHÔNG phun tiêu đề thô làm idea)`);
  return [];
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
      const idea = extractJson(await callLLMForPrototyper(prompt)) as Idea;
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

/**
 * expandUserIdea — user nhập keyword ngắn hoặc description dài, LLM
 * enrich thành ScoredIdea đầy đủ (title EN/VI, pitch, features, target...).
 * Dùng cho manual submit — bypass HN/GitHub sourcing.
 * source = "manual: <input snippet>".
 */
export async function expandUserIdea(input: string): Promise<ScoredIdea> {
  const trimmed = input.trim();
  const isKeyword = trimmed.length < 60 && !/[.!?\n]/.test(trimmed);
  const mode = isKeyword ? "keyword" : "description";
  const sourceTag = `manual: ${trimmed.slice(0, 60)}${trimmed.length > 60 ? "…" : ""}`;

  if (useLLMEnrich) {
    const prompt = `Bạn là "Prototyper". User tự đề xuất 1 ý tưởng ${mode === "keyword" ? "dưới dạng keyword ngắn" : "kèm mô tả cụ thể"}:

"${trimmed}"

Nhiệm vụ: enrich thành 1 idea GỐC đầy đủ. Nếu user chỉ cho keyword, tự sáng tạo product cụ thể xoay quanh keyword đó. Nếu user đã có description, giữ ý user và cấu trúc lại theo schema.

TIÊU CHÍ (giữ nguyên chất lượng như batch):
- title_en/title_vi chỉ là tên product ngắn (KHÔNG em-dash + tagline — tagline đã ở pitch riêng).
- Có góc riêng vs. tool cùng lĩnh vực.
- Buildable 1 ngày (2-24h).
- Target user cụ thể.
- Song ngữ EN + VI.

**Quan trọng về type**: nếu input đề cập iOS/Android/React Native/Expo/mobile/điện thoại → dùng type="mobile-expo".

Trả JSON object, không markdown, không giải thích:
{"title_en":"...","title_vi":"...","slug":"kebab-case","type":"web-frontend|full-stack|cli|browser-extension|mobile-expo",
"pitch_en":"1 câu tagline","pitch_vi":"...",
"features_en":["3-5 bullet feature core"],"features_vi":["..."],
"flow_vi":"3-5 câu tiếng Việt kể user flow end-to-end: mở app → làm gì → thấy gì → giá trị nhận được","flow_en":"same in English",
"feature_notes_vi":["song song features — mỗi feature 1-2 câu tiếng Việt: vì sao cần, dùng lúc nào"],"feature_notes_en":["same in English"],
"target_user_en":"1 câu ai dùng","target_user_vi":"...",
"why_now_en":"1 câu vì sao lúc này","why_now_vi":"...",
"risk_en":"1 câu rủi ro/giả định lớn nhất","risk_vi":"...",
"demo_hours":6}`;
    try {
      const raw = await callLLMForPrototyper(prompt, { num_predict: 8192 });
      const it = extractJson(raw);
      const titleEn = String(it.title_en ?? it.title ?? trimmed);
      const t: ProjectType = (["web-frontend", "full-stack", "cli", "browser-extension", "mobile-expo"].includes(it.type)
        ? it.type : "web-frontend") as ProjectType;
      log(`   ✓ Prototyper enrich manual idea "${titleEn}" (mode: ${mode})`);
      return {
        title: titleEn,
        slug: slugify(String(it.slug ?? titleEn)),
        type: t,
        pitch: String(it.pitch_en ?? ""),
        why: String(it.why_now_vi ?? it.why_now_en ?? "User đề xuất trực tiếp."),
        source: sourceTag,
        score: 0.8,   // user-submitted → boost điểm lên nhẹ, CEO review vẫn quyết
        title_en: titleEn, title_vi: String(it.title_vi ?? titleEn),
        pitch_en: String(it.pitch_en ?? ""), pitch_vi: String(it.pitch_vi ?? ""),
        why_en: String(it.why_now_en ?? ""), why_vi: String(it.why_now_vi ?? ""),
        features_en: Array.isArray(it.features_en) ? it.features_en.slice(0, 5).map(String) : undefined,
        features_vi: Array.isArray(it.features_vi) ? it.features_vi.slice(0, 5).map(String) : undefined,
        flow_vi: it.flow_vi ? String(it.flow_vi) : undefined,
        flow_en: it.flow_en ? String(it.flow_en) : undefined,
        feature_notes_vi: Array.isArray(it.feature_notes_vi) ? it.feature_notes_vi.slice(0, 5).map(String) : undefined,
        feature_notes_en: Array.isArray(it.feature_notes_en) ? it.feature_notes_en.slice(0, 5).map(String) : undefined,
        target_user_en: it.target_user_en ? String(it.target_user_en) : undefined,
        target_user_vi: it.target_user_vi ? String(it.target_user_vi) : undefined,
        why_now_en: it.why_now_en ? String(it.why_now_en) : undefined,
        why_now_vi: it.why_now_vi ? String(it.why_now_vi) : undefined,
        risk_en: it.risk_en ? String(it.risk_en) : undefined,
        risk_vi: it.risk_vi ? String(it.risk_vi) : undefined,
        demo_hours: typeof it.demo_hours === "number" ? Math.max(1, Math.min(24, Math.round(it.demo_hours))) : undefined,
      };
    } catch (e: any) {
      log(`   ✗ expandUserIdea LLM lỗi: ${e?.message ?? e} → raw fallback`);
    }
  }

  // Fallback (LLM off / lỗi): dùng nguyên input làm title + pitch.
  const rawTitle = trimmed.split(/[.!?\n]/)[0].slice(0, 60) || "Untitled";
  return {
    title: rawTitle, slug: slugify(rawTitle), type: "web-frontend",
    pitch: trimmed.slice(0, 200), why: "User đề xuất trực tiếp.",
    source: sourceTag, score: 0.5,
    title_en: rawTitle, title_vi: rawTitle,
    pitch_en: trimmed.slice(0, 200), pitch_vi: trimmed.slice(0, 200),
    why_en: "Direct user submission.", why_vi: "User đề xuất trực tiếp.",
  };
}

// ===================== CHẠY ĐỘC LẬP ===============================
if (import.meta.main) {
  const idea = await collectIdea();
  log("\n🏆 Ý tưởng được chọn:");
  log(JSON.stringify(idea, null, 2));
}
