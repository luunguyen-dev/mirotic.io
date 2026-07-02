/**
 * server.ts — Bun.serve wrapper. Bootstraps HTTP server + logs URL.
 */

import { CONFIG } from "../config";
import { log } from "../util/logger";
import { handleFetch } from "./routes";

export function startServer(): void {
  Bun.serve({
    port: CONFIG.port,
    fetch: handleFetch,
  });
  log(`🌐 Dashboard: ${CONFIG.baseUrl}`);
}
