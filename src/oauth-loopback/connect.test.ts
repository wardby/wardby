import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CONNECT_MESSAGES, secretConnectCommand } from "./connect.js";

const TOKEN = "tok-secret-link-token";
const PROVIDER_CODE = "provider-code-xyz";
const STATE = "state-value-abc";
const CONFIRM = "ABCD-2345";

interface Seen {
  start: { auth?: string; origin?: string; body?: Record<string, unknown> }[];
  complete: { auth?: string; origin?: string; body?: Record<string, unknown> }[];
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((r) => {
          s.closeAllConnections();
          s.close(() => r());
        }),
    ),
  );
});

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = "";
  for await (const chunk of req) text += String(chunk);
  return JSON.parse(text) as Record<string, unknown>;
}

/** A Wardby double: the two loopback routes, with the L2 contract. */
async function wardby(
  opts: { startStatus?: number; completeStatus?: number; completeBody?: unknown; startBody?: unknown } = {},
) {
  const seen: Seen = { start: [], complete: [] };
  const server = createServer((req, res) => void handle(req, res));
  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readJson(req);
    const record = { auth: req.headers.authorization, origin: req.headers.origin, body };
    res.setHeader("content-type", "application/json");
    if (req.url === "/oauth/loopback/start") {
      seen.start.push(record);
      const status = opts.startStatus ?? 200;
      res.statusCode = status;
      res.end(
        JSON.stringify(
          status === 200
            ? (opts.startBody ?? {
                authorizeUrl: `https://provider.example/authorize?state=${STATE}&redirect_uri=${encodeURIComponent(String(body.redirectUri))}`,
                expiresAt: new Date(Date.now() + 600_000).toISOString(),
                name: "browserstack",
              })
            : { error: "link_invalid" },
        ),
      );
    } else if (req.url === "/oauth/loopback/complete") {
      seen.complete.push(record);
      res.statusCode = opts.completeStatus ?? 200;
      res.end(JSON.stringify(opts.completeBody ?? { confirmationCode: CONFIRM }));
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  };
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, link: `${origin}/oauth/loopback#${TOKEN}`, seen };
}

/** Plays the browser: follows the authorize URL to the provider's redirect to the CLI's listener. */
function browser(query: string, hits: { status?: number; body?: string }[] = []) {
  return async (authorizeUrl: string) => {
    const redirect = new URL(new URL(authorizeUrl).searchParams.get("redirect_uri") as string);
    setTimeout(() => {
      void fetch(`${redirect.origin}${redirect.pathname}?${query}`).then(async (r) => {
        hits.push({ status: r.status, body: await r.text() });
      });
    }, 5);
    return true;
  };
}

function run(link: string, extra: Partial<Parameters<typeof secretConnectCommand>[1]> = {}, args = ["-"]) {
  const lines: string[] = [];
  const promise = secretConnectCommand(args, { readLink: async () => link, out: (l) => lines.push(l), ...extra });
  return promise.then((code) => ({ code, text: lines.join("\n"), lines }));
}

function expectNoSecrets(text: string) {
  for (const secret of [TOKEN, PROVIDER_CODE, STATE]) expect(text).not.toContain(secret);
}

describe("wardby secret connect", () => {
  it("runs the full flow and prints the confirmation code and the next step", async () => {
    const w = await wardby();
    const hits: { status?: number; body?: string }[] = [];
    const opened: string[] = [];
    const open = browser(`code=${PROVIDER_CODE}&state=${STATE}&iss=https%3A%2F%2Fprovider.example`, hits);
    const { code, text } = await run(w.link, {
      openBrowser: async (u) => (opened.push(u), open(u)),
    });
    expect(code).toBe(0);
    expect(text).toContain(`Confirmation code: ${CONFIRM}`);
    expect(text).toContain(`create_secret({ name: "browserstack", confirmationCode: "${CONFIRM}" })`);
    expectNoSecrets(text);
    expect(opened).toHaveLength(1);

    expect(w.seen.start).toHaveLength(1);
    expect(w.seen.start[0].auth).toBe(`Bearer ${TOKEN}`);
    expect(w.seen.start[0].origin).toBeUndefined();
    expect(Object.keys(w.seen.start[0].body ?? {})).toEqual(["redirectUri"]);
    expect(w.seen.start[0].body?.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:[1-9]\d{3,4}\/callback$/);
    expect(w.seen.complete).toHaveLength(1);
    expect(w.seen.complete[0].auth).toBe(`Bearer ${TOKEN}`);
    expect(w.seen.complete[0].origin).toBeUndefined();
    expect(w.seen.complete[0].body).toEqual({ code: PROVIDER_CODE, state: STATE, iss: "https://provider.example" });
    await new Promise((r) => setTimeout(r, 20));
    expect(hits[0]?.status).toBe(200);
    expect(hits[0]?.body).toContain("You can close this tab");
    expectNoSecrets(hits[0]?.body ?? "");
  });

  it("omits iss when absent and forwards an empty iss as an empty string", async () => {
    const a = await wardby();
    await run(a.link, { openBrowser: browser(`code=${PROVIDER_CODE}&state=${STATE}`) });
    expect(a.seen.complete[0].body).toEqual({ code: PROVIDER_CODE, state: STATE });
    const b = await wardby();
    await run(b.link, { openBrowser: browser(`code=${PROVIDER_CODE}&state=${STATE}&iss=`) });
    expect(b.seen.complete[0].body).toEqual({ code: PROVIDER_CODE, state: STATE, iss: "" });
  });

  it("closes the listener after the first callback and answers other paths 404", async () => {
    const w = await wardby();
    let redirect: URL | undefined;
    const { code } = await run(w.link, {
      openBrowser: async (u) => {
        redirect = new URL(new URL(u).searchParams.get("redirect_uri") as string);
        const other = await fetch(`${redirect.origin}/other`);
        expect(other.status).toBe(404);
        const post = await fetch(`${redirect.origin}/callback`, { method: "POST" });
        expect(post.status).toBe(404);
        void fetch(`${redirect.origin}/callback?code=${PROVIDER_CODE}&state=${STATE}`);
        return true;
      },
    });
    expect(code).toBe(0);
    await expect(fetch(`${redirect?.origin}/callback?code=x&state=y`)).rejects.toThrow();
  });

  it("prints the sign-in address only with --no-browser or when no browser starts", async () => {
    const w = await wardby();
    const captured: string[] = [];
    const sim = browser(`code=${PROVIDER_CODE}&state=${STATE}`);
    const lines: string[] = [];
    const code = await secretConnectCommand(["-", "--no-browser"], {
      readLink: async () => w.link,
      out: (l) => {
        lines.push(l);
        const m = /^https:\/\/provider\.example\S+/.exec(l);
        if (m) {
          captured.push(m[0]);
          void sim(m[0]);
        }
      },
      openBrowser: async () => {
        throw new Error("must not open");
      },
    });
    expect(code).toBe(0);
    expect(captured).toHaveLength(1);
    expect(lines.join("\n")).not.toContain(TOKEN);

    const w2 = await wardby();
    const failing = await run(w2.link, {
      openBrowser: async (u) => (void sim(u), false),
    });
    expect(failing.code).toBe(0);
    expect(failing.text).toContain(CONNECT_MESSAGES.browserFailed);
  });

  it("reports access_denied as a cancelled sign-in without calling complete", async () => {
    const w = await wardby();
    const { code, text } = await run(w.link, {
      openBrowser: browser(`error=access_denied&state=${STATE}&error_description=nope`),
    });
    expect(code).toBe(1);
    expect(text).toContain(CONNECT_MESSAGES.denied);
    expect(w.seen.complete).toHaveLength(0);
    expectNoSecrets(text);
  });

  it("reports other provider errors and incomplete redirects with fixed messages", async () => {
    const a = await wardby();
    const err = await run(a.link, { openBrowser: browser(`error=server_error&state=${STATE}`) });
    expect(err.text).toContain(CONNECT_MESSAGES.providerError);
    const b = await wardby();
    const missing = await run(b.link, { openBrowser: browser(`code=${PROVIDER_CODE}`) });
    expect(missing.code).toBe(1);
    expect(missing.text).toContain(CONNECT_MESSAGES.badCallback);
    expect(b.seen.complete).toHaveLength(0);
    expectNoSecrets(missing.text);
  });

  it("times out when no redirect arrives and frees the port", async () => {
    const w = await wardby();
    let redirect: URL | undefined;
    const { code, text } = await run(w.link, {
      waitMs: 50,
      openBrowser: async (u) => {
        redirect = new URL(new URL(u).searchParams.get("redirect_uri") as string);
        return true;
      },
    });
    expect(code).toBe(1);
    expect(text).toContain(CONNECT_MESSAGES.timedOut);
    await expect(fetch(`${redirect?.origin}/callback?code=x&state=y`)).rejects.toThrow();
  });

  it("refuses a non-https, non-loopback origin before any request", async () => {
    const { code, text } = await run(`http://wardby.example.com/oauth/loopback#${TOKEN}`, {
      fetch: async () => {
        throw new Error("must not fetch");
      },
    });
    expect(code).toBe(1);
    expect(text).toContain(CONNECT_MESSAGES.insecureOrigin);
    expectNoSecrets(text);
  });

  it("accepts https origins (checked without connecting)", async () => {
    const calls: string[] = [];
    const { text } = await run(`https://wardby.example.com/oauth/loopback#${TOKEN}`, {
      fetch: (url) => {
        calls.push(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
        return Promise.reject(new Error("net"));
      },
    });
    expect(calls).toEqual(["https://wardby.example.com/oauth/loopback/start"]);
    expect(text).toContain(CONNECT_MESSAGES.unreachable);
    expectNoSecrets(text);
  });

  it("refuses malformed links with a fixed message that never echoes them", async () => {
    for (const bad of [
      `https://wardby.example.com/oauth/loopback?t=${TOKEN}`,
      `https://wardby.example.com/other#${TOKEN}`,
      `ftp://wardby.example.com/oauth/loopback#${TOKEN}`,
      `not a link ${TOKEN}`,
    ]) {
      const { code, text } = await run(bad);
      expect(code).toBe(1);
      expect(text).toContain(CONNECT_MESSAGES.badLink);
      expectNoSecrets(text);
    }
    expect((await run("   ")).text).toContain(CONNECT_MESSAGES.noLink);
  });

  it("takes no link on the command line", async () => {
    const lines: string[] = [];
    const code = await secretConnectCommand([`https://x.example/oauth/loopback#${TOKEN}`], {
      out: (l) => lines.push(l),
    });
    expect(code).toBe(2);
    expect(lines.join("\n")).not.toContain(TOKEN);
    expect(await secretConnectCommand([], { out: () => undefined })).toBe(2);
    expect(await secretConnectCommand(["--help"], { out: () => undefined })).toBe(0);
  });

  it("maps start refusals to fixed messages", async () => {
    for (const [status, message] of [
      [403, CONNECT_MESSAGES.linkRejected],
      [401, CONNECT_MESSAGES.linkRejected],
      [429, CONNECT_MESSAGES.tooMany],
      [502, CONNECT_MESSAGES.startFailed],
    ] as const) {
      const w = await wardby({ startStatus: status });
      const { code, text } = await run(w.link);
      expect(code).toBe(1);
      expect(text).toBe(message);
    }
  });

  it("refuses an unusable authorize address", async () => {
    const w = await wardby({ startBody: { authorizeUrl: "javascript:alert(1)", expiresAt: "x", name: "n" } });
    const { code, text } = await run(w.link, {
      openBrowser: async () => {
        throw new Error("must not open");
      },
    });
    expect(code).toBe(1);
    expect(text).toBe(CONNECT_MESSAGES.badAuthorizeUrl);
  });

  it("reports a failed completion with a fixed message", async () => {
    const w = await wardby({ completeStatus: 502, completeBody: { error: "failed" } });
    const { code, text } = await run(w.link, { openBrowser: browser(`code=${PROVIDER_CODE}&state=${STATE}`) });
    expect(code).toBe(1);
    expect(text).toBe(
      `Complete the sign-in in your browser. Waiting for the provider ...\n${CONNECT_MESSAGES.completeFailed}`,
    );
    expectNoSecrets(text);
  });

  it("falls back to a generic next step when the start response has no name", async () => {
    const w = await wardby({
      startBody: { authorizeUrl: "https://provider.example/authorize?redirect_uri=PLACEHOLDER", expiresAt: "x" },
    });
    // Rewrite the placeholder to the real redirect URI the CLI sent.
    const fix = browser(`code=${PROVIDER_CODE}&state=${STATE}`);
    const { text } = await run(w.link, {
      openBrowser: async () =>
        fix(`https://provider.example/a?redirect_uri=${encodeURIComponent(String(w.seen.start[0].body?.redirectUri))}`),
    });
    expect(text).toContain('create_secret({ name: "<secret name>"');
  });
});
