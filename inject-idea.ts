/**
 * inject-idea.ts — chèn 1 ý tưởng cụ thể vào DB với status=approved để test executor.
 * Chạy: bun run inject-idea.ts
 */
import { SQL } from "bun";
import * as db from "./db";
import type { Idea } from "./prototyper";

const idea: Idea = {
  title: "Pi to 1000 digits",
  slug: "pi-1000-digits",
  type: "web-frontend",
  pitch: "Trang web tĩnh in số π và 1000 chữ số sau dấu chấm.",
  why: "Test xác minh hệ thống executor có thể tự sinh code thật. Trang chỉ cần 1 file HTML duy nhất, hiển thị '3.' rồi 1000 chữ số sau (precomputed hoặc tính bằng JS, miễn là chính xác). Có thể thêm tiêu đề và CSS gọn.",
  source: "manual-inject",
};

const plan = {
  problem: idea.why,
  tenStar: "Một trang duy nhất, load tức thì, copy được toàn bộ chuỗi.",
  scopeCut: "Chỉ in π + 1000 chữ số. Không animation, không backend.",
  stack: "Single HTML file (no build), inline CSS+JS",
  buildSteps: ["Tạo index.html", "Tính/paste π 1000 chữ số", "CSS gọn"],
  testPlan: ["Mở file trong browser thấy đủ chữ số", "Đếm đủ 1000"],
  tasteDecisions: ["Static HTML, không cần Vite/React"],
};

await db.initDb();
const id = await db.insertJob(idea, plan);
await db.setStatus(id, "approved");

// Clear started_at của các job today để poller's gate "1 ý tưởng/ngày" cho phép build.
const url = process.env.DATABASE_URL;
if (url) {
  const sql = new SQL(url);
  const today = new Date().toISOString().slice(0, 10);
  const r = await sql`UPDATE jobs SET started_at = NULL WHERE started_at IS NOT NULL AND left(started_at, 10) = ${today}`;
  console.log(`   cleared started_at of ${r.count ?? "?"} today's job(s)`);
  await sql.end();
}

console.log(`✅ injected ${id} → status=approved`);
await db.closeDb();
