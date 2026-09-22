import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createSecureServer, type Http2SecureServer } from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetch as undiciFetch } from "undici";
import { installHttpRuntime } from "./http-runtime.js";

const run = promisify(execFile);

/**
 * The regression this file exists for: importing `@kubernetes/client-node`
 * (userland undici 8) hands Node's built-in fetch a dispatcher it cannot drive
 * losslessly, and every response then arrives with no headers and an
 * undecompressed body. It only shows over HTTP/2 — undici 8 negotiates h2 by
 * default, the built-in client does not — so the server here is a real TLS h2
 * server returning gzip JSON, which is the shape every API wardby calls has.
 *
 * Self-signed, hence NODE_TLS_REJECT_UNAUTHORIZED: a per-request CA would need
 * a per-request dispatcher, and a per-request dispatcher is exactly what this
 * test must NOT use — the whole point is to exercise the process-global one.
 */
const PAYLOAD = { hello: "world" };
const BODY = gzipSync(Buffer.from(JSON.stringify(PAYLOAD)));

let server: Http2SecureServer | undefined;
let url = "";
let directory = "";
let tlsRejectBefore: string | undefined;
let openssl = true;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "wardby-http-runtime-"));
  try {
    await run("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(directory, "key.pem"),
      "-out",
      join(directory, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ]);
  } catch {
    // No openssl: the h2 server cannot be stood up. The identity assertion
    // below still runs and still fails if the install is removed.
    openssl = false;
    return;
  }
  tlsRejectBefore = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  const [key, cert] = await Promise.all([readFile(join(directory, "key.pem")), readFile(join(directory, "cert.pem"))]);
  const created = createSecureServer({ key, cert, allowHTTP1: true }, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "x-marker": "1" });
    response.end(BODY);
  });
  await new Promise<void>((resolve) => created.listen(0, "127.0.0.1", resolve));
  const address = created.address();
  url = `https://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
  server = created;
  // Whatever imports it first in a real process, this is what poisons the
  // global dispatcher; do it explicitly so the test does not depend on suite
  // ordering for its RED condition.
  await import("@kubernetes/client-node");
});

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
  if (tlsRejectBefore === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = tlsRejectBefore;
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("http runtime", () => {
  it("keeps global fetch usable after the Kubernetes client claims the global dispatcher", async () => {
    expect(openssl, "openssl is required to generate the test server's certificate").toBe(true);
    const response = await globalThis.fetch(url);
    expect(response.status).toBe(200);
    // Without the install these are the two observed symptoms: zero headers,
    // and a body that is still gzip (so json() throws on 0x1f).
    expect([...response.headers.keys()].length).toBeGreaterThan(0);
    expect(response.headers.get("x-marker")).toBe("1");
    await expect(response.json()).resolves.toEqual(PAYLOAD);
  });

  it("installs undici's own fetch stack as one consistent unit", () => {
    expect(globalThis.fetch).toBe(undiciFetch);
    const built = new Response("{}", { headers: { "content-type": "application/json" } });
    expect(built).toBeInstanceOf(Response);
    expect(new Headers(built.headers).get("content-type")).toBe("application/json");
  });

  it("is idempotent", () => {
    const before = globalThis.fetch;
    installHttpRuntime();
    installHttpRuntime();
    expect(globalThis.fetch).toBe(before);
  });

  it("leaves the WebSocket and EventSource globals to Node", () => {
    // undici.install() would replace these; wardby deliberately does not (the
    // Kubernetes exec path uses `ws`, the MCP SSE client the `eventsource`
    // package), so this pins the decision, not undici's behaviour.
    expect(globalThis.WebSocket.name).toBe("WebSocket");
    expect(typeof globalThis.MessageEvent).toBe("function");
  });
});
