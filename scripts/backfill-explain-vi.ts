/**
 * backfill-explain-vi.ts — sinh diễn giải song ngữ (flow_vi/en + feature_notes_vi/en)
 * cho các job cũ chưa có, ghi ngược vào idea_json. Giữ nguyên field đã tồn tại.
 *
 * Chạy: bun run scripts/backfill-explain-vi.ts [--dry]
 * Idempotent — job đã đủ cả VI + EN thì skip.
 */

import { initDb } from "../src/db";
import { callTextWithFallback } from "../src/executor/ceo";

const DRY = process.argv.includes("--dry");
const CHUNK = 6;

await initDb();
const { SQL } = await import("bun");
const sql = new SQL(process.env.DATABASE_URL!);

const rows: Array<{ id: string; idea_json: string }> =
  await sql`SELECT id, idea_json FROM jobs ORDER BY created_at DESC`;

const todo = rows
  .map((r) => ({ id: r.id, idea: JSON.parse(r.idea_json) }))
  .filter((r) => !r.idea.flow_vi || !r.idea.flow_en);

console.log(`Jobs thiếu diễn giải: ${todo.length}/${rows.length}`);
if (!todo.length) process.exit(0);

for (let i = 0; i < todo.length; i += CHUNK) {
  const chunk = todo.slice(i, i + CHUNK);
  const prompt = `Bạn là "Prototyper". Với mỗi idea dưới đây, viết diễn giải SONG NGỮ gồm:
- flow_vi / flow_en: 3-5 câu kể user flow end-to-end (mở app → làm gì → thấy gì → giá trị nhận được). Văn kể chuyện, không bullet. flow_en là bản tiếng Anh tự nhiên cùng nội dung.
- feature_notes_vi / feature_notes_en: mảng song song với features (cùng số lượng, cùng thứ tự) — mỗi feature 1-2 câu: vì sao cần, dùng lúc nào.
Nếu idea đã kèm "Flow VI có sẵn" thì flow_en/feature_notes_en phải khớp nội dung bản VI đó (dịch tự nhiên, không sáng tác mới).

IDEAS:
${chunk.map((r, k) => `${k + 1}. id="${r.id}"
   Title: ${r.idea.title_en ?? r.idea.title}
   Pitch: ${r.idea.pitch_en ?? r.idea.pitch}
   Target: ${r.idea.target_user_en ?? "—"}
   Features: ${(r.idea.features_en ?? r.idea.features ?? []).map((f: string, j: number) => `(${j + 1}) ${f}`).join(" ")}${r.idea.flow_vi ? `
   Flow VI có sẵn: ${r.idea.flow_vi}
   Notes VI có sẵn: ${(r.idea.feature_notes_vi ?? []).join(" | ")}` : ""}`).join("\n")}

Trả JSON array DUY NHẤT, không markdown:
[{"id":"...","flow_vi":"...","flow_en":"...","feature_notes_vi":["..."],"feature_notes_en":["..."]},...]`;

  try {
    const { model, output } = await callTextWithFallback("prototyper", prompt, { timeoutMs: 120_000, num_predict: 16384 });
    const m = output.match(/\[[\s\S]*\]/);
    if (!m) { console.log(`✗ chunk ${i / CHUNK + 1}: không parse được JSON`); continue; }
    const items = JSON.parse(m[0]) as Array<{ id: string; flow_vi: string; flow_en: string; feature_notes_vi: string[]; feature_notes_en: string[] }>;
    for (const it of items) {
      const row = chunk.find((r) => r.id === it.id);
      if (!row || (!it.flow_vi && !it.flow_en)) { console.log(`  ? bỏ qua ${it.id}`); continue; }
      // Giữ field đã tồn tại — chỉ điền chỗ thiếu.
      const idea = {
        ...row.idea,
        flow_vi: row.idea.flow_vi ?? (it.flow_vi ? String(it.flow_vi) : undefined),
        flow_en: row.idea.flow_en ?? (it.flow_en ? String(it.flow_en) : undefined),
        feature_notes_vi: row.idea.feature_notes_vi ?? (Array.isArray(it.feature_notes_vi) ? it.feature_notes_vi.slice(0, 5).map(String) : undefined),
        feature_notes_en: row.idea.feature_notes_en ?? (Array.isArray(it.feature_notes_en) ? it.feature_notes_en.slice(0, 5).map(String) : undefined),
      };
      if (DRY) { console.log(`  [dry] ${it.id}: ${idea.flow_vi.slice(0, 80)}…`); continue; }
      await sql`UPDATE jobs SET idea_json = ${JSON.stringify(idea)} WHERE id = ${it.id}`;
      console.log(`  ✓ ${it.id} (via ${model})`);
    }
  } catch (e: any) {
    console.log(`✗ chunk ${i / CHUNK + 1}: ${e?.message ?? e}`);
  }
}
console.log("Done.");
process.exit(0);
