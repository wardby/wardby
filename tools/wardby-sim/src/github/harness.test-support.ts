// TEST ONLY (wardby-sim). A simulator with GitHub seeded for unit tests: an installation, a
// repository, helpers to call routes with real installation tokens, and wardby's own
// GitHubAppClient wired to the simulator through a fetch adapter.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { importPKCS8, SignJWT } from "jose";
import { createPrivateKey } from "node:crypto";
import { GitHubAppClient } from "../../../../src/providers/vcs/github.js";
import { createSimServer, simRequest, type SimServer } from "../server.js";
import type { SimService } from "../service.js";
import { createGitHubSim, GITHUB_API_PREFIX } from "./service.js";
import type { GitHubState, Permission } from "./state.js";
import { SIM_APP_ID } from "./test-app-key.js";

export const TEST_APP_PRIVATE_KEY = readFileSync(
  resolve(import.meta.dirname, "../../fixtures/github-app-test-key.pem"),
  "utf8",
);
export const OWNER = "acme";
export const REPO = "acme/widgets";
export const INSTALLATION = 42;

export interface Harness {
  sim: SimServer;
  gh: GitHubState;
  script(steps: Record<string, unknown>[]): Promise<unknown[]>;
  call(
    method: string,
    path: string,
    body?: unknown,
    options?: { token?: string; accept?: string; headers?: Record<string, string> },
  ): Promise<{ status: number; body: any; headers: Record<string, string> }>;
  appJwt(opts?: { appId?: number; key?: string; iatOffset?: number; expOffset?: number }): Promise<string>;
  mint(permissions: Record<string, Permission>, repositories?: string[]): Promise<string>;
  /** wardby's real client, its requests answered by the simulator. */
  client(): GitHubAppClient;
}

export async function githubHarness(
  options: { files?: Record<string, string>; extra?: SimService[] } = {},
): Promise<Harness> {
  const github = createGitHubSim({ app: { ownerLogin: OWNER } });
  const sim = createSimServer({ services: [github.service, github.gitService, ...(options.extra ?? [])] });
  const gh = github.state;
  const script = async (steps: Record<string, unknown>[]): Promise<unknown[]> => {
    const response = await sim.dispatch(simRequest("POST", "/__sim/script", { steps }));
    const body = JSON.parse(String(response.body)) as { results?: unknown[]; message?: string; error?: string };
    if (response.status !== 200) throw new Error(`script failed: ${body.error} ${body.message ?? ""}`);
    return body.results!;
  };
  await script([
    { action: "github.install", account: OWNER, id: INSTALLATION },
    {
      action: "github.repo",
      repo: REPO,
      files: options.files ?? { "README.md": "# widgets\n", "src/a.ts": "export const a = 1;\n" },
    },
  ]);
  const appJwt: Harness["appJwt"] = async (opts = {}) => {
    const pkcs8 = createPrivateKey(opts.key ?? TEST_APP_PRIVATE_KEY)
      .export({ type: "pkcs8", format: "pem" })
      .toString();
    const now = Math.floor(gh.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuedAt(now + (opts.iatOffset ?? -60))
      .setExpirationTime(now + (opts.expOffset ?? 540))
      .setIssuer(String(opts.appId ?? SIM_APP_ID))
      .sign(await importPKCS8(pkcs8, "RS256"));
  };
  const call: Harness["call"] = async (method, path, body, opts = {}) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.accept) headers.accept = opts.accept;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await sim.dispatch(simRequest(method, `${GITHUB_API_PREFIX}${path}`, body, headers));
    const raw =
      response.body === undefined
        ? ""
        : Buffer.isBuffer(response.body)
          ? response.body.toString("utf8")
          : response.body;
    let parsed: unknown = raw;
    try {
      parsed = raw ? JSON.parse(raw) : undefined;
    } catch {
      // raw text
    }
    return { status: response.status, body: parsed, headers: response.headers ?? {} };
  };
  const mint: Harness["mint"] = async (permissions, repositories = ["widgets"]) => {
    const response = await call(
      "POST",
      `/app/installations/${INSTALLATION}/access_tokens`,
      { permissions, repositories },
      { token: await appJwt() },
    );
    if (response.status !== 201) throw new Error(`mint failed ${response.status}`);
    return (response.body as { token: string }).token;
  };
  const client = (): GitHubAppClient => {
    const fetchAdapter = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const body = typeof init?.body === "string" ? init.body : undefined;
      const response = await sim.dispatch(
        simRequest(init?.method ?? "GET", `${GITHUB_API_PREFIX}${url.pathname}${url.search}`, body, headers),
      );
      return new Response(response.status === 204 ? null : (response.body ?? null), {
        status: response.status,
        headers: response.headers ?? {},
      });
    }) as typeof fetch;
    return new GitHubAppClient(
      { appId: String(SIM_APP_ID), privateKey: TEST_APP_PRIVATE_KEY },
      fetchAdapter,
      () => new Date(gh.now()),
    );
  };
  return { sim, gh, script, call, appJwt, mint, client };
}
