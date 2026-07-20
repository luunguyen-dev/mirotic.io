/**
 * deployer.ts — Deploy demo-ready job lên EC2 qua ship.sh.
 *
 * Flow:
 *   1. Verify build artifacts còn nguyên (Dockerfile + compose + ship.sh + README).
 *   2. Ghi .shipenv (SLUG, EC2_HOST, EC2_USER, SSH_KEY, PORT, CADDY_DOMAIN) cho ship.sh đọc.
 *   3. bash ./ship.sh — pipe stdout/stderr live vào job_logs.
 *   4. On success: setResult status=deployed + email notify.
 *   5. On fail: mark plan step failed, setResult status=failed.
 *
 * Public port hash từ slug (base 9000) để tránh đụng nhau giữa các project trên cùng EC2.
 */

import { CONFIG } from "../config";
import * as db from "../db";
import { jLog } from "../util/logger";
import { sendEmail, deployedEmail } from "../util/email";
import { updatePlanStep } from "./planner";
import { verifyBuildArtifacts } from "./builder";
import type { Idea } from "../types";

const PUBLIC_PORT_BASE = 9000;
const hash = (s: string) => {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
};

export async function deploy(id: string): Promise<void> {
  const job = await db.getJob(id);
  if (!job) return;
  const idea = job.idea as Idea;
  const cwd = `${CONFIG.builds}/${id}`;
  const slug = idea.slug;
  const publicPort = PUBLIC_PORT_BASE + (Math.abs(hash(slug)) % 900);
  const domain = `${slug}.${CONFIG.deployDomain}`;
  const isMobileType = idea.type === "mobile-expo";
  jLog(id, `🚀 DEPLOY → ${CONFIG.awsHost} — ${id}${isMobileType ? " (mobile: EAS Build + APK)" : ""}`);
  await updatePlanStep(id, "deploy", "in_progress");

  try {
    // 1) Verify build artifacts còn nguyên
    const missing = await verifyBuildArtifacts(cwd, idea.type);
    if (missing.length) throw new Error(`thiếu artifact: ${missing.join(", ")}`);

    // 2) Ghi .shipenv (web) hoặc setup ENV cho ship-mobile.sh
    const env = process.env;
    if (!isMobileType) {
      const shipenv = [
        `SLUG=${slug}`,
        `EC2_HOST=${env.AWS_HOST}`,
        `EC2_USER=${env.SSH_USER ?? "ec2-user"}`,
        `SSH_KEY=${env.SSH_KEY}`,
        `PORT=${publicPort}`,
        `CADDY_DOMAIN=${domain}`,
      ].join("\n") + "\n";
      await Bun.write(`${cwd}/.shipenv`, shipenv);
    }
    // Mobile: ship-mobile.sh đọc SSH_KEY/SSH_USER/AWS_HOST trực tiếp từ env (đã có sẵn).

    // 3) Chạy ship script — pipe + tail vào job_logs
    const shipScript = isMobileType ? "./ship-mobile.sh" : "./ship.sh";
    jLog(id, `[ship] bash ${shipScript} — ${isMobileType ? `EAS Build APK → ${domain}/app.apk` : `domain=${domain} port=${publicPort}`}`);
    const proc = Bun.spawn(["bash", shipScript], { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, DEPLOY_DOMAIN: CONFIG.deployDomain } });
    const pipeToLog = async (stream: ReadableStream<Uint8Array>, isStderr: boolean) => {
      const reader = stream.getReader(); const dec = new TextDecoder(); let buf = "";
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() ?? "";
        for (const l of lines) {
          if (!l.trim()) continue;
          (isStderr ? process.stderr : process.stdout).write(l + "\n");
          db.appendLog(id, l.slice(0, 400), isStderr ? "error" : "tool").catch(() => {});
        }
      }
    };
    await Promise.all([pipeToLog(proc.stdout as any, false), pipeToLog(proc.stderr as any, true)]);
    await proc.exited;
    if (proc.exitCode !== 0) throw new Error(`${shipScript} exit ${proc.exitCode}`);

    const deployedUrl = `https://${domain}`;
    const apkUrl = isMobileType ? `${deployedUrl}/app.apk` : undefined;
    await db.setResult(id, { ...(job.result ?? {}), deployedUrl, publicPort, ...(apkUrl ? { apkUrl } : {}) }, "deployed");
    await updatePlanStep(id, "deploy", "done", apkUrl ?? deployedUrl);
    await sendEmail(`🚀 Đã deploy: ${idea.title}`, deployedEmail(idea, apkUrl ?? deployedUrl), "deployed");
    jLog(id, `✓ deployed · ${apkUrl ?? deployedUrl}`, "summary");
  } catch (e: any) {
    jLog(id, `[ship] FAILED: ${e?.message ?? e}`, "error");
    await updatePlanStep(id, "deploy", "failed", String(e?.message ?? e));
    await db.setResult(id, { ...(job.result ?? {}), error: String(e?.message ?? e) }, "failed");
  }
}
