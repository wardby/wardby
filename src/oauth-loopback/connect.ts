/**
 * `wardby secret connect -`: signs in to an OAuth provider for a hosted Wardby server from the
 * owner's machine. The link (from create_secret with `callback: "loopback"`) is pasted on stdin.
 * The command listens on 127.0.0.1, asks Wardby to start the sign-in with that redirect URI, opens
 * the provider's page, catches the one redirect, hands the code to Wardby and prints the
 * confirmation code.
 *
 * Runs without a database or any server configuration, so this module (and everything it imports)
 * stays light: node built-ins and the link helpers only.
 *
 * The link, the authorization code and the state are credentials: none is ever printed or logged,
 * and every failure is a fixed message. The one exception is `--no-browser` (and a browser that
 * cannot be started), which prints the provider's sign-in address because the owner must open it.
 */
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import {
  OAUTH_LOOPBACK_COMPLETE_PATH,
  OAUTH_LOOPBACK_START_PATH,
  parseOAuthLoopbackLink,
} from "../mcp/tools/oauth-loopback-link.js";

export const SECRET_CONNECT_USAGE = `usage: wardby secret connect - [--no-browser]

Sign in to an OAuth provider for a secret on your Wardby server. Run create_secret with
oauth.callback "loopback" first: it returns this command and a link (valid for 10 minutes).
Paste the link when asked (or pipe it in); it is never taken as an argument, so it stays out of
your shell history and the process list.

  --no-browser  Print the sign-in address instead of opening a browser`;

const MAX_LINK_BYTES = 8192;
const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
/** How long the listener waits for the provider's redirect. */
export const CONNECT_WAIT_MS = 10 * 60_000;

const CLOSE_PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><title>Wardby</title></head><body><p>You can close this tab.</p></body></html>';

export const CONNECT_MESSAGES = {
  noLink: "No link was given. Paste the link create_secret returned.",
  badLink: "That is not a Wardby connect link.",
  insecureOrigin: "Refusing to use a link that points to a non-https address.",
  unreachable: "Could not reach the Wardby server.",
  linkRejected: "The connect link is invalid or has expired. Ask for a new one with create_secret.",
  tooMany: "Too many sign-ins are waiting for this secret. Wait a few minutes and try again.",
  startFailed: "Wardby could not start the sign-in. Check the secret settings and try again.",
  badAuthorizeUrl: "Wardby returned an unusable sign-in address.",
  listenFailed: "Could not listen on this machine for the provider's redirect.",
  denied: "The sign-in was cancelled or refused at the provider.",
  providerError: "The provider returned an error. Start again with a new link.",
  badCallback: "The provider's redirect was incomplete. Start again with a new link.",
  timedOut: "Timed out waiting for the sign-in. Start again with a new link.",
  completeFailed: "Wardby could not finish the sign-in. Start again with a new link.",
  browserFailed: "Could not open a browser. Open this address to sign in:",
} as const;

export interface ConnectDeps {
  fetch?: typeof globalThis.fetch;
  /** Opens the sign-in address; resolves false (or throws) when no browser could be started. */
  openBrowser?: (url: string) => Promise<boolean>;
  /** Reads the pasted link (default: standard input). */
  readLink?: () => Promise<string>;
  out?: (line: string) => void;
  waitMs?: number;
}

class ConnectError extends Error {}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

async function readLinkFromStdin(out: (line: string) => void): Promise<string> {
  if (process.stdin.isTTY) {
    out("Paste the connect link:");
    const rl = createInterface({ input: process.stdin, terminal: false });
    try {
      for await (const line of rl) return line.slice(0, MAX_LINK_BYTES);
      return "";
    } finally {
      rl.close();
    }
  }
  let text = "";
  for await (const chunk of process.stdin) {
    text += String(chunk);
    if (text.length > MAX_LINK_BYTES) return "";
  }
  return text;
}

/** Starts the platform's opener without a shell, so the address is never interpreted. */
export function openInBrowser(url: string): Promise<boolean> {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : ["xdg-open", [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

interface CallbackParams {
  code: string | null;
  state: string | null;
  iss: string | null;
  error: string | null;
}

/** Listens on 127.0.0.1 for exactly one `GET /callback`. */
function listenForCallback(waitMs: number) {
  let settle!: (value: CallbackParams | "timeout") => void;
  const result = new Promise<CallbackParams | "timeout">((resolve) => (settle = resolve));
  let done = false;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method !== "GET" || url.pathname !== "/callback") {
      res.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      connection: "close",
    });
    res.end(CLOSE_PAGE);
    if (done) return;
    done = true;
    const q = url.searchParams;
    settle({ code: q.get("code"), state: q.get("state"), iss: q.get("iss"), error: q.get("error") });
  });
  const timer = setTimeout(() => {
    if (!done) {
      done = true;
      settle("timeout");
    }
  }, waitMs);
  const ready = new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
  const close = () => {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections();
  };
  return { ready, result, close };
}

async function postJson(
  doFetch: typeof globalThis.fetch,
  url: string,
  token: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> | undefined }> {
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      redirect: "error",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ConnectError(CONNECT_MESSAGES.unreachable);
  }
  let json: Record<string, unknown> | undefined;
  try {
    const text = await res.text();
    if (text.length <= MAX_RESPONSE_BYTES) {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
    }
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

function startFailure(status: number): string {
  if (status === 401 || status === 403) return CONNECT_MESSAGES.linkRejected;
  if (status === 429) return CONNECT_MESSAGES.tooMany;
  return CONNECT_MESSAGES.startFailed;
}

/** Returns the process exit code: 0 connected, 1 failed, 2 usage. */
export async function secretConnectCommand(argv: string[], deps: ConnectDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => process.stderr.write(`${line}\n`));
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: { "no-browser": { type: "boolean" }, help: { type: "boolean", short: "h" } },
    });
  } catch {
    out(SECRET_CONNECT_USAGE);
    return 2;
  }
  if (parsed.values.help) {
    out(SECRET_CONNECT_USAGE);
    return 0;
  }
  // The link is never an argument: only "-" (read it from standard input).
  if (parsed.positionals.length !== 1 || parsed.positionals[0] !== "-") {
    out(SECRET_CONNECT_USAGE);
    return 2;
  }
  const doFetch = deps.fetch ?? globalThis.fetch;
  let listener: ReturnType<typeof listenForCallback> | undefined;
  try {
    const raw = (await (deps.readLink ?? (() => readLinkFromStdin(out)))()).trim();
    if (raw === "") throw new ConnectError(CONNECT_MESSAGES.noLink);
    const link = parseOAuthLoopbackLink(raw);
    if (!link) throw new ConnectError(CONNECT_MESSAGES.badLink);
    const origin = new URL(link.origin);
    if (origin.protocol !== "https:" && !(origin.protocol === "http:" && isLoopbackHost(origin.hostname))) {
      throw new ConnectError(CONNECT_MESSAGES.insecureOrigin);
    }

    listener = listenForCallback(deps.waitMs ?? CONNECT_WAIT_MS);
    let port: number;
    try {
      port = await listener.ready;
    } catch {
      throw new ConnectError(CONNECT_MESSAGES.listenFailed);
    }

    const start = await postJson(doFetch, `${link.origin}${OAUTH_LOOPBACK_START_PATH}`, link.token, {
      redirectUri: `http://127.0.0.1:${port}/callback`,
    });
    const authorizeUrl = start.json?.authorizeUrl;
    if (start.status !== 200) throw new ConnectError(startFailure(start.status));
    if (typeof authorizeUrl !== "string" || !URL.canParse(authorizeUrl)) {
      throw new ConnectError(CONNECT_MESSAGES.badAuthorizeUrl);
    }
    const scheme = new URL(authorizeUrl).protocol;
    if (scheme !== "https:" && scheme !== "http:") throw new ConnectError(CONNECT_MESSAGES.badAuthorizeUrl);
    const name = typeof start.json?.name === "string" ? start.json.name : undefined;

    // The address carries the sign-in state, so it is printed only when the owner has to open it.
    let opened = false;
    if (!parsed.values["no-browser"]) {
      try {
        opened = await (deps.openBrowser ?? openInBrowser)(authorizeUrl);
      } catch {
        opened = false;
      }
      if (!opened) out(CONNECT_MESSAGES.browserFailed);
    } else {
      out("Open this address to sign in:");
    }
    if (!opened) out(authorizeUrl);
    else out("Complete the sign-in in your browser. Waiting for the provider ...");

    const callback = await listener.result;
    listener.close();
    listener = undefined;
    if (callback === "timeout") throw new ConnectError(CONNECT_MESSAGES.timedOut);
    if (callback.error !== null) {
      throw new ConnectError(
        callback.error === "access_denied" ? CONNECT_MESSAGES.denied : CONNECT_MESSAGES.providerError,
      );
    }
    if (!callback.code || !callback.state) throw new ConnectError(CONNECT_MESSAGES.badCallback);

    const complete = await postJson(doFetch, `${link.origin}${OAUTH_LOOPBACK_COMPLETE_PATH}`, link.token, {
      code: callback.code,
      state: callback.state,
      // Forwarded exactly as received (an empty value is refused by the server, failing closed).
      ...(callback.iss !== null ? { iss: callback.iss } : {}),
    });
    const confirmation = complete.json?.confirmationCode;
    if (
      complete.status !== 200 ||
      typeof confirmation !== "string" ||
      !/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/.test(confirmation)
    ) {
      throw new ConnectError(CONNECT_MESSAGES.completeFailed);
    }
    out(`Confirmation code: ${confirmation}`);
    out("Finish in your MCP client:");
    out(`  create_secret({ name: ${JSON.stringify(name ?? "<secret name>")}, confirmationCode: "${confirmation}" })`);
    return 0;
  } catch (err) {
    out(err instanceof ConnectError ? err.message : CONNECT_MESSAGES.startFailed);
    return 1;
  } finally {
    listener?.close();
  }
}
