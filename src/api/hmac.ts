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
// Key = short name; value = model name gửi CLI.
// Key "auto" là sentinel — không set builder_model, để registry tự route theo complexity + cooldown.
export const BUILDER_CHOICES: Record<string, string> = {
  auto: "",   // sentinel: hệ thống quyết định (complexity-adaptive + auto-fallback)
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-4-8",
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
