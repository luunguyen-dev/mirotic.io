/**
 * backfill-explain-vi.ts — sinh diễn giải tiếng Việt (flow_vi + feature_notes_vi)
 * cho các job cũ chưa có, ghi ngược vào idea_json.
 *
 * Chạy: bun run scripts/backfill-explain-vi.ts [--dry]
 * Idempotent — job đã có flow_vi thì skip.
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
  .filter((r) => !r.idea.flow_vi);

console.log(`Jobs thiếu diễn giải: ${todo.length}/${rows.length}`);
if (!todo.length) process.exit(0);

for (let i = 0; i < todo.length; i += CHUNK) {
  const chunk = todo.slice(i, i + CHUNK);
  const prompt = `Bạn là "Prototyper". Với mỗi idea dưới đây, viết diễn giải tiếng Việt gồm:
- flow_vi: 3-5 câu kể user flow end-to-end (mở app → làm gì → thấy gì → giá trị nhận được). Văn kể chuyện, không bullet.
- feature_notes_vi: mảng song song với features (cùng số lượng, cùng thứ tự) — mỗi feature 1-2 câu: vì sao cần, dùng lúc nào.

IDEAS:
${chunk.map((r, k) => `${k + 1}. id="${r.id}"
   Title: ${r.idea.title_en ?? r.idea.title}
   Pitch: ${r.idea.pitch_en ?? r.idea.pitch}
   Target: ${r.idea.target_user_en ?? "—"}
   Features: ${(r.idea.features_en ?? r.idea.features ?? []).map((f: string, j: number) => `(${j + 1}) ${f}`).join(" ")}`).join("\n")}

Trả JSON array DUY NHẤT, không markdown:
[{"id":"...","flow_vi":"...","feature_notes_vi":["..."]},...]`;

  try {
    const { model, output } = await callTextWithFallback("prototyper", prompt, { timeoutMs: 120_000, num_predict: 16384 });
    const m = output.match(/\[[\s\S]*\]/);
    if (!m) { console.log(`✗ chunk ${i / CHUNK + 1}: không parse được JSON`); continue; }
    const items = JSON.parse(m[0]) as Array<{ id: string; flow_vi: string; feature_notes_vi: string[] }>;
    for (const it of items) {
      const row = chunk.find((r) => r.id === it.id);
      if (!row || !it.flow_vi) { console.log(`  ? bỏ qua ${it.id}`); continue; }
      const idea = {
        ...row.idea,
        flow_vi: String(it.flow_vi),
        feature_notes_vi: Array.isArray(it.feature_notes_vi) ? it.feature_notes_vi.slice(0, 5).map(String) : undefined,
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
