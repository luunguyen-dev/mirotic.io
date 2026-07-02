/**
 * logger.ts — jLog + log + sleep utils.
 * jLog ghi vào cả console + job_logs (fire-and-forget).
 */

import * as db from "../db";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const log = (s = "") => console.log(s);

export const jLog = (jobId: string, msg: string, level = "info") => {
  console.log(msg);
  db.appendLog(jobId, msg, level).catch(() => {});
};
