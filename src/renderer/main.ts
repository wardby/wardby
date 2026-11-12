/**
 * Entry point of the optional wardby-renderer service (deploy/Dockerfile, stage renderer): headless
 * Chromium behind a small HTTP API on PORT (default 8796). It needs no database and no secrets.
 */
import { logger } from "../core/logger.js";
import { launchChrome } from "./chrome.js";
import { createRendererServer } from "./server.js";

const log = logger.child({ module: "renderer" });

function port(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 8796;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65_535) throw new Error("PORT must be an integer from 1 to 65535.");
  return n;
}

async function main(): Promise<void> {
  const listenPort = port(process.env.PORT);
  const chrome = await launchChrome();
  const server = createRendererServer(chrome);
  server.listen(listenPort, "0.0.0.0", () => log.info({ port: listenPort }, "renderer listening"));
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "renderer stopping");
    server.close();
    server.closeIdleConnections();
    void chrome.close().finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}

main().catch((err: unknown) => {
  log.error({ err }, "renderer failed to start");
  process.exit(1);
});
