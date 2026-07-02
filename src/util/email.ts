/**
 * email.ts — Resend API wrapper + templates cho notifications demo-ready / deployed.
 * Nếu không có RESEND_API_KEY hoặc EMAIL_TO → mock (write to outbox HTML file).
 */

import { writeFileSync } from "node:fs";
import { CONFIG } from "../config";
import { log } from "./logger";
import type { Idea, Result } from "../types";

export async function sendEmail(subject: string, html: string, tag: string): Promise<void> {
  const file = `${CONFIG.outbox}/${Date.now()}-${tag}.html`;
  writeFileSync(file, html);
  if (!CONFIG.resendApiKey || !CONFIG.emailTo) return void log(`   📧 (mock) "${subject}" → ${file}`);
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${CONFIG.resendApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: CONFIG.emailFrom, to: CONFIG.emailTo, subject, html }),
    });
    log(r.ok ? `   📧 gửi → ${CONFIG.emailTo}` : `   ⚠️ email lỗi ${r.status}`);
  } catch (e) { log(`   ⚠️ email error: ${e}`); }
}

export function demoReadyEmail(idea: Idea, r: Result): string {
  return `<h2>🧪 Demo sẵn sàng để test: ${idea.title}</h2>
<p><b>Đang chạy trên Mac:</b> <a href="${r.localUrl}">${r.localUrl}</a> (docker đã up — mở browser test)</p>
<p><b>Repo private mới:</b> <a href="${r.repoUrl}">${r.repoUrl}</a> (branch <code>${r.branch}</code>)</p>
<p style="color:#666">Ưng thì bấm <b>Deploy</b> trên web để đẩy lên AWS.</p>`;
}

export function deployedEmail(idea: Idea, url: string): string {
  return `<h2>🚀 Đã deploy: ${idea.title}</h2><p>Live: <a href="${url}">${url}</a></p>`;
}
