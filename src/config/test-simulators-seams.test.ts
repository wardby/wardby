/**
 * Where WARDBY_TEST_SIMULATORS is consulted: with the switch off every base is what it was
 * before the switch existed; with it on, each goes to the simulator; with a refusal, each
 * construction site refuses (fails closed) rather than falling back to the real service.
 */
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "#prisma";
import { GitHubAppClient } from "../providers/vcs/github.js";
import { buildVcsProvider } from "../providers/vcs/index.js";
import { NodeGitCommandRunner } from "../providers/vcs/git.js";
import { startConfiguredCodingProxy } from "../providers/coding-proxy/runtime.js";
import type { CodingProxyServerHandle } from "../providers/coding-proxy/server.js";
import { CODING_PROXY_DENY_PORT, CODING_PROXY_PORT } from "../providers/jobs/docker-isolation.js";
import { loadJiraConfig, loadSlackConfig } from "./providers.js";

const SIM_KEY = readFileSync(
  join(import.meta.dirname, "../../tools/wardby-sim/fixtures/github-app-test-key.pem"),
  "utf8",
);
const OTHER_KEY = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs1", format: "pem" })
  .toString();
const BASE = "http://wardby-sim.wardby-sim.svc:8080";
const ON = { WARDBY_TEST_SIMULATORS: "1", WARDBY_SIM_BASE_URL: BASE };
const JIRA = {
  WARDBY_JIRA_SITE_URL: "https://acme.atlassian.net",
  WARDBY_JIRA_API_BASE_URL: "https://api.atlassian.com/ex/jira/0b6a1f2e-1111-2222-3333-444455556666",
  WARDBY_JIRA_API_TOKEN: "sim-jira-token",
  WARDBY_JIRA_WEBHOOK_SECRET: "x".repeat(24),
};

/** The process environment under the switch, without this machine's own tokens (which it would refuse). */
function stubSimulatorProcessEnv(privateKey: string): void {
  for (const name of [
    "WARDBY_SLACK_BOT_TOKEN",
    "WARDBY_JIRA_API_TOKEN",
    "GITHUB_APP_CLIENT_SECRET",
    "WARDBY_HOSTNAME",
    "MCP_CANONICAL_URI",
  ]) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv("WARDBY_TEST_SIMULATORS", "1");
  vi.stubEnv("WARDBY_SIM_BASE_URL", BASE);
  vi.stubEnv("GITHUB_APP_PRIVATE_KEY", privateKey);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function githubUrlCalled(privateKey: string): Promise<string> {
  const fetch = vi.fn(
    async () => new Response(JSON.stringify({ id: 1, slug: "wardby-sim", owner: { login: "acme" } })),
  );
  const client = new GitHubAppClient({ appId: "424242", privateKey }, fetch);
  await client.appIdentity();
  return String((fetch.mock.calls[0] as unknown[])[0]);
}

describe("the switch off leaves every base as it was", () => {
  it("GitHub API, clone URL, Slack, Jira", async () => {
    expect(await githubUrlCalled(OTHER_KEY)).toBe("https://api.github.com/app");
    const vcs = buildVcsProvider({ vcs: "github" }, { appId: "1", privateKey: OTHER_KEY }, {});
    const remote = (vcs as any).options.github.remote;
    expect(remote.cloneUrl("acme/widgets")).toBe("https://github.com/acme/widgets.git");
    expect(loadSlackConfig({ WARDBY_SLACK_BOT_TOKEN: "xoxb-1-2-abc" })?.apiBaseUrl).toBe("https://slack.com/api");
    expect(loadJiraConfig({ ...JIRA })?.apiBaseUrl).toBe(JIRA.WARDBY_JIRA_API_BASE_URL);
  });

  it("the coding proxy still pins every registry host", async () => {
    let allowedHosts: string[] = [];
    await startProxy({}, (options) => {
      allowedHosts = options.allowedHosts;
      return vi.fn();
    });
    expect(allowedHosts.sort()).toEqual(["api.osv.dev", "files.pythonhosted.org", "pypi.org", "registry.npmjs.org"]);
  });
});

describe("the switch on points each base at the simulator", () => {
  it("GitHub API and clone URLs", async () => {
    stubSimulatorProcessEnv(SIM_KEY);
    expect(await githubUrlCalled(SIM_KEY)).toBe(`${BASE}/github/api/app`);
    const vcs = buildVcsProvider({ vcs: "github" }, { appId: "1", privateKey: SIM_KEY }, { ...ON });
    expect((vcs as any).options.github.remote.cloneUrl("acme/widgets")).toBe(`${BASE}/github/git/acme/widgets.git`);
  });

  it("Slack and Jira (Jira over https only)", () => {
    expect(loadSlackConfig({ ...ON, WARDBY_SLACK_BOT_TOKEN: "xoxb-sim-1" })?.apiBaseUrl).toBe(`${BASE}/slack/api`);
    const https = { WARDBY_TEST_SIMULATORS: "1", WARDBY_SIM_BASE_URL: "https://wardby-sim.wardby-sim.svc:8443" };
    expect(loadJiraConfig({ ...https, ...JIRA })?.apiBaseUrl).toBe("https://wardby-sim.wardby-sim.svc:8443/jira");
    expect(() => loadJiraConfig({ ...ON, ...JIRA })).toThrow("test_simulators_refused:jira_needs_https");
  });

  it("the coding proxy sends registry hosts to the simulator and builds no pinned fetch", async () => {
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        seen.push(String(url));
        return new Response("{}");
      }),
    );
    const createPinnedFetch = vi.fn();
    const started = await startProxy({ ...ON }, createPinnedFetch);
    expect(createPinnedFetch).not.toHaveBeenCalled();
    const upstream = (started.registry as any).options.upstream as (url: string) => Promise<Response>;
    await upstream("https://registry.npmjs.org/left-pad");
    await expect(upstream("https://example.com/x")).rejects.toThrow("proxy_egress_blocked");
    expect(seen).toEqual([`${BASE}/npm/left-pad`]);
  });
});

describe("a refusal fails each construction site closed", () => {
  it("never falls back to the real service", async () => {
    stubSimulatorProcessEnv(OTHER_KEY);
    expect(() => new GitHubAppClient({ appId: "1", privateKey: OTHER_KEY })).toThrow(
      "test_simulators_refused:github_app_key_not_simulator",
    );
    stubSimulatorProcessEnv(SIM_KEY);
    const env = { ...ON, NODE_ENV: "production" };
    expect(() => buildVcsProvider({ vcs: "github" }, { appId: "1", privateKey: SIM_KEY }, env)).toThrow(
      "test_simulators_refused:node_env_production",
    );
    expect(() => loadSlackConfig({ ...ON, WARDBY_SLACK_BOT_TOKEN: "xoxb-1-2-real" })).toThrow(
      "test_simulators_refused:slack_token_not_simulator",
    );
    await expect(startProxy({ ...ON, WARDBY_SIM_BASE_URL: "http://evil.example.com" }, vi.fn())).rejects.toThrow(
      "test_simulators_refused:base_host_not_local",
    );
  });
});

async function startProxy(
  env: NodeJS.ProcessEnv,
  createPinnedFetch: (options: { allowedHosts: string[] }) => unknown,
): Promise<{ registry: unknown }> {
  const handle: CodingProxyServerHandle = { port: CODING_PROXY_PORT, close: async () => {} };
  const startServer = vi.fn(async () => handle);
  await startConfiguredCodingProxy({
    db: {} as PrismaClient,
    env,
    startServer,
    startDenyPort: async () => ({ port: CODING_PROXY_DENY_PORT, close: async () => {} }),
    createPinnedFetch: createPinnedFetch as never,
  });
  const calls = startServer.mock.calls as unknown as [unknown, { registry: unknown }][];
  return { registry: calls[0][1].registry };
}

describe("wardby's git commands under the switch", () => {
  it("trust the simulator's CA (GIT_SSL_CAINFO) only with the switch on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wardby-sim-git-env-"));
    try {
      const ca = join(dir, "ca.crt");
      writeFileSync(ca, "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n");
      const git = join(dir, "fake-git.mjs");
      writeFileSync(
        git,
        `#!${process.execPath}\nconsole.log(JSON.stringify({ ca: process.env.GIT_SSL_CAINFO ?? null }));\n`,
      );
      chmodSync(git, 0o700);
      const runner = new NodeGitCommandRunner({ gitBinary: git, homeDir: dir });
      expect(JSON.parse((await runner.run(["status"])).stdout)).toEqual({ ca: null });
      stubSimulatorProcessEnv(SIM_KEY);
      expect(JSON.parse((await runner.run(["status"])).stdout)).toEqual({ ca: null });
      vi.stubEnv("WARDBY_SIM_CA_FILE", ca);
      expect(JSON.parse((await runner.run(["status"])).stdout)).toEqual({ ca });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
