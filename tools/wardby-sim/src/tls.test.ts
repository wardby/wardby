import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSimServer, type SimServer } from "./server.js";
import { buildServices } from "./services.js";

const ROOT = resolve(import.meta.dirname, "../../..");
const hasOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** A separate Node process (a "pod") fetching the simulator, with or without the CA trusted. */
function podFetch(url: string, caFile?: string): Promise<{ ok: boolean; output: string }> {
  const script = `fetch(${JSON.stringify(url)}).then(async (r) => { console.log("status", r.status); }, (e) => { console.log("error", e.cause?.code ?? e.message); process.exit(1); })`;
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, ...(caFile ? { NODE_EXTRA_CA_CERTS: caFile } : {}) };
  return new Promise((done) => {
    execFile(process.execPath, ["-e", script], { env }, (error, stdout) => done({ ok: !error, output: stdout.trim() }));
  });
}

describe.skipIf(!hasOpenssl)("wardby-sim TLS with a throwaway CA (deploy/kind-coding/sim-ca.sh)", () => {
  let dir: string;
  let sim: SimServer;
  let url: string;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "wardby-sim-ca-"));
    execFileSync("bash", [join(ROOT, "deploy/kind-coding/sim-ca.sh"), dir], { stdio: "ignore" });
    sim = createSimServer({
      services: buildServices({ env: { WARDBY_SIM_GIT_ROOT: join(dir, "git") } }),
      tls: { cert: readFileSync(join(dir, "tls.crt")), key: readFileSync(join(dir, "tls.key")) },
    });
    url = `${(await sim.listen()).replace("127.0.0.1", "localhost")}/__sim/health`;
  });
  afterAll(async () => {
    await sim?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a pod that trusts the CA reaches the simulator over https", async () => {
    expect(url.startsWith("https://localhost:")).toBe(true);
    expect(await podFetch(url, join(dir, "ca.crt"))).toEqual({ ok: true, output: "status 200" });
  });

  it("a pod without the CA fails TLS", async () => {
    const result = await podFetch(url);
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(
      /^error (UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT_LOCALLY)/,
    );
  });

  it("keeps the server key private (0600)", () => {
    const mode = execFileSync(
      "stat",
      process.platform === "darwin" ? ["-f", "%Lp", join(dir, "tls.key")] : ["-c", "%a", join(dir, "tls.key")],
    )
      .toString()
      .trim();
    expect(mode).toBe("600");
  });
});
