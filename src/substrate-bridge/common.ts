/** Pieces both bridges share: identity, logging, the readiness server, uploads. */
import { access, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { AGENT_SUFFIX, RUN_TOKEN_PATTERN, TOOL_SUFFIX } from "./constants.js";
import { BridgeError, send, withRetry, type RetryPolicy } from "./http.js";

/**
 * A bridge log call. `event` is a fixed code; fields are numbers, the run token, channel ids and
 * fixed words. Never a line, body, header value, tool setup or environment.
 */
export type Logger = (event: string, fields?: Record<string, string | number>) => void;

export const stderrLogger: Logger = (event, fields = {}) => {
  process.stderr.write(`${JSON.stringify({ event, ...fields })}\n`);
};

/** Reads `<dir>/name`, strips the role suffix, and checks the run token's shape. */
export async function readRunToken(metadataDir: string, role: "agent" | "tool"): Promise<string> {
  let name: string;
  try {
    name = (await readFile(`${metadataDir}/name`, "utf8")).trim();
  } catch {
    throw new BridgeError("substrate_bridge_identity_invalid");
  }
  const suffix = role === "agent" ? AGENT_SUFFIX : TOOL_SUFFIX;
  const token = name.endsWith(suffix) ? name.slice(0, -suffix.length) : "";
  if (!RUN_TOKEN_PATTERN.test(token)) throw new BridgeError("substrate_bridge_identity_invalid");
  return token;
}

export function requireProxyUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.WARDBY_PROXY_URL;
  if (!raw) throw new BridgeError("substrate_bridge_env_missing");
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
  } catch {
    throw new BridgeError("substrate_bridge_env_missing");
  }
  return raw.replace(/\/+$/, "");
}

/** GET /readyz -> 200 (the template's wake-up probe). Pass port 0 for an ephemeral port. */
export function startReadyServer(port: number): Promise<{ server: Server; port: number }> {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/readyz") response.writeHead(200).end("ok");
    else response.writeHead(404).end();
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

export const UPLOAD_ATTEMPTS = 10;
export const UPLOAD_TIMEOUT_MS = 10 * 60_000;

export type UploadOutcome = "ok" | "skipped" | "rejected" | "failed";

/** Uploads a file with its Content-Length. A missing file is skipped; every 4xx is terminal; transport failures stop after UPLOAD_ATTEMPTS. */
export async function uploadFile(
  url: string,
  headers: Record<string, string>,
  path: string,
  policy: RetryPolicy,
  log: Logger,
  what: string,
  signal?: AbortSignal,
): Promise<UploadOutcome> {
  try {
    await access(path);
  } catch {
    return "skipped";
  }
  try {
    const result = await withRetry(
      () => send(url, { method: "POST", headers, uploadFile: path, timeoutMs: UPLOAD_TIMEOUT_MS, signal }),
      { policy, maxAttempts: UPLOAD_ATTEMPTS, signal },
    );
    if (result.status === 200) {
      log("substrate_bridge_uploaded", { what });
      return "ok";
    }
    log("substrate_bridge_upload_rejected", { what, status: result.status });
    return "rejected";
  } catch {
    log("substrate_bridge_upload_failed", { what });
    return "failed";
  }
}
