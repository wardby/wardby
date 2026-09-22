import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createSecureServer, type Http2SecureServer } from "node:http2";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetch as undiciFetch, getGlobalDispatcher, Response as UndiciResponse } from "undici";
import { installHttpRuntime } from "./http-runtime.js";

const run = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The regression this file exists for: importing `@kubernetes/client-node`
 * (userland undici 8) hands Node's built-in fetch a dispatcher whose HTTP/2
 * path forwards an http2 headers OBJECT into the v1 `onHeaders` contract, which
 * expects a flat array — so the built-in handler sees zero headers and never
 * gunzips. It only shows over h2, which the built-in client never negotiates on
 * its own, so the server here is a real TLS h2 server returning gzip JSON: the
 * shape every API wardby calls has, and the only shape that reproduces it.
 *
 * Self-signed, hence NODE_TLS_REJECT_UNAUTHORIZED: trusting a per-test CA would
 * need a per-request dispatcher, and a per-request dispatcher is exactly what
 * this test must NOT use — the whole point is the process-global one.
 */
const PAYLOAD = { hello: "world" };
const BODY = gzipSync(Buffer.from(JSON.stringify(PAYLOAD)));

let server: Http2SecureServer | undefined;
let url = "";
let directory = "";
let tlsRejectBefore: string | undefined;
let openssl = true;
// Inside node_modules (git-ignored, and an ancestor of the repo's own
// node_modules) so the probe's bare `undici` import resolves the way a real
// entry point's does.
const probeDirectory = join(repoRoot, "node_modules", ".cache", "wardby-http-runtime");
let dispatcherBeforeKubernetesImport: unknown;
let dispatcherAfterKubernetesImport: unknown;

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
    // No openssl: the h2 server cannot be stood up, and the test below says so
    // rather than passing vacuously.
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
  // Whatever imports it first in a real process, this is what claims the global
  // dispatcher; do it explicitly so the RED condition does not depend on suite
  // ordering, and bracket it to pin the load-order contract.
  dispatcherBeforeKubernetesImport = getGlobalDispatcher();
  await import("@kubernetes/client-node");
  dispatcherAfterKubernetesImport = getGlobalDispatcher();
});

afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) => server?.close((error) => (error ? reject(error) : resolve())));
  if (tlsRejectBefore === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = tlsRejectBefore;
  if (directory) await rm(directory, { recursive: true, force: true });
  await rm(probeDirectory, { recursive: true, force: true });
});

describe("http runtime", () => {
  it("keeps global fetch usable over h2 after the Kubernetes client claims the global dispatcher", async () => {
    expect(openssl, "openssl is required to generate the test server's certificate").toBe(true);
    const response = await globalThis.fetch(url);
    expect(response.status).toBe(200);
    // Without the fix these are the two observed symptoms: zero headers, and a
    // body that is still gzip (so json() throws on 0x1f).
    expect([...response.headers.keys()].length).toBeGreaterThan(0);
    expect(response.headers.get("x-marker")).toBe("1");
    await expect(response.json()).resolves.toEqual(PAYLOAD);
  });

  it("installs its dispatcher before the Kubernetes client, which then leaves it alone", () => {
    // undici's lib/global.js installs its own h2-enabled default Agent only
    // when getGlobalDispatcher() is undefined, so landing first is the contract.
    expect(dispatcherBeforeKubernetesImport).toBeDefined();
    expect(dispatcherAfterKubernetesImport).toBe(dispatcherBeforeKubernetesImport);
  });

  it("leaves Node's own fetch stack in place instead of swapping the globals", () => {
    // The narrow fix is a dispatcher, not an install(): the MCP SDK and the
    // LLM SDKs brand-check Headers/Response, so the built-in classes stay.
    expect(globalThis.fetch).not.toBe(undiciFetch);
    expect(globalThis.Response).not.toBe(UndiciResponse);
    expect(new Response("{}") instanceof UndiciResponse).toBe(false);
    expect(globalThis.WebSocket.name).toBe("WebSocket");
    expect(typeof globalThis.MessageEvent).toBe("function");
  });

  it("is idempotent", () => {
    const before = getGlobalDispatcher();
    installHttpRuntime();
    installHttpRuntime();
    expect(getGlobalDispatcher()).toBe(before);
  });

  it("is wired into the production entry point, not just the test setup", async () => {
    // vitest.setup.ts installs the runtime independently, so without this the
    // suite stays green even if env.ts's import is deleted and every deployment
    // breaks. Run the real load order in a child process: env.ts only.
    // `.mts` so tsx treats the probe as ESM regardless of where it sits.
    await mkdir(probeDirectory, { recursive: true });
    const probe = join(probeDirectory, "probe.mts");
    await writeFile(
      probe,
      [
        `import ${JSON.stringify(join(repoRoot, "src", "env.ts"))};`,
        `const installed = globalThis[Symbol.for("wardby.httpRuntime.installed")] === true;`,
        `const { getGlobalDispatcher } = await import("undici");`,
        `const before = getGlobalDispatcher();`,
        `await import("@kubernetes/client-node");`,
        `process.stdout.write(JSON.stringify({ installed, kept: getGlobalDispatcher() === before }));`,
      ].join("\n"),
      "utf8",
    );
    const { stdout } = await run(join(repoRoot, "node_modules", ".bin", "tsx"), [probe], { cwd: repoRoot });
    expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}")).toEqual({ installed: true, kept: true });
  }, 60_000);
});
