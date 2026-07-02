/**
 * hmac.ts — Action tokens + BUILDER_CHOICES + ACTIONS map.
 */

import { createHmac } from "node:crypto";
import { CONFIG } from "../config";
import type { JobStatus } from "../db";

export const sign = (id: string, action: string) =>
  createHmac("sha256", CONFIG.hmacSecret).update(`${id}:${action}`).digest("hex");
export const verify = (id: string, action: string, token: string) => sign(id, action) === token;

// Actions đổi status trực tiếp qua HMAC link.
export const ACTIONS: Record<string, JobStatus> = {
  approve: "approved", reject: "rejected", deploy: "deploy-requested",
};

// Special actions không đổi status theo pattern ACTIONS.
export const PROMOTE_ACTION = "promote";
export const RETRY_ACTION = "retry";

// User có thể pick model builder qua dropdown khi Approve.
//
// Key = model identifier gửi tới Claude CLI (`--model <key>`).
//       Đặc biệt: "auto" là sentinel = KHÔNG set builder_model → registry
//       tự route theo complexity + cooldown fallback.
// Value = label hiển thị (tên chính thức + version như Anthropic công bố).
//
// Mở rộng: thêm entry mới ở đây, không cần đổi code route hoặc UI.
export const BUILDER_CHOICES: Record<string, string> = {
  "auto":                        "Auto",
  "claude-sonnet-5":             "Claude Sonnet 5",
  "claude-opus-4-8":             "Claude Opus 4.8",
  "claude-haiku-4-5-20251001":   "Claude Haiku 4.5",
};
export const BUILDER_DEFAULT = "auto";

// Compute HMAC signs bundle cho tất cả action của 1 job.
export function jobSigns(id: string) {
  return {
    approve: sign(id, "approve"),
    reject: sign(id, "reject"),
    deploy: sign(id, "deploy"),
    promote: sign(id, "promote"),
    retry: sign(id, "retry"),
  };
}
