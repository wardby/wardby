import { createHash, createPublicKey, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SIM_APP_KEY_FINGERPRINT } from "../../tools/wardby-sim/src/github/test-app-key.js";
import {
  createSimulatorRegistryFetch,
  isLocalSimulatorHost,
  loadTestSimulators,
  SIMULATOR_GITHUB_APP_KEY_FINGERPRINT,
  testSimulatorBase,
  TestSimulatorsRefused,
  type TestSimulatorsRefusal,
} from "./test-simulators.js";

const ROOT = join(import.meta.dirname, "../..");
const SIM_KEY = readFileSync(join(ROOT, "tools/wardby-sim/fixtures/github-app-test-key.pem"), "utf8");
const BASE = "http://wardby-sim.wardby-sim.svc.cluster.local:8080";
const ON = { WARDBY_TEST_SIMULATORS: "1", WARDBY_SIM_BASE_URL: BASE };

function refusal(env: NodeJS.ProcessEnv): TestSimulatorsRefusal | "none" {
  try {
    loadTestSimulators(env);
    return "none";
  } catch (error) {
    expect(error).toBeInstanceOf(TestSimulatorsRefused);
    return (error as TestSimulatorsRefused).reason;
  }
}

describe("WARDBY_TEST_SIMULATORS refusals", () => {
  it("is off, and touches nothing, when neither variable is set", () => {
    expect(loadTestSimulators({})).toBeNull();
    expect(testSimulatorBase("github-api", {})).toBeNull();
    // Production settings alone are none of its business.
    expect(
      loadTestSimulators({ NODE_ENV: "production", GITHUB_APP_PRIVATE_KEY: "x", WARDBY_HOSTNAME: "app.example.com" }),
    ).toBeNull();
  });

  const cases: [string, NodeJS.ProcessEnv, TestSimulatorsRefusal][] = [
    ["flag without base", { WARDBY_TEST_SIMULATORS: "1" }, "partial"],
    ["base without flag", { WARDBY_SIM_BASE_URL: BASE }, "partial"],
    ["flag not 1", { ...ON, WARDBY_TEST_SIMULATORS: "true" }, "flag_value"],
    ["release image", { ...ON, WARDBY_TEST_SIMULATORS_ALLOWED: "0" }, "release_image"],
    ["unparsable base", { ...ON, WARDBY_SIM_BASE_URL: "not a url" }, "base_url_invalid"],
    ["userinfo", { ...ON, WARDBY_SIM_BASE_URL: "http://user:hunter2-pass@localhost:8080" }, "base_url_credentials"],
    ["username only", { ...ON, WARDBY_SIM_BASE_URL: "http://tok@localhost:8080" }, "base_url_credentials"],
    ["ftp", { ...ON, WARDBY_SIM_BASE_URL: "ftp://localhost" }, "base_url_form"],
    ["path", { ...ON, WARDBY_SIM_BASE_URL: "http://localhost:8080/x" }, "base_url_form"],
    ["query", { ...ON, WARDBY_SIM_BASE_URL: "http://localhost:8080/?a=1" }, "base_url_form"],
    ["public host", { ...ON, WARDBY_SIM_BASE_URL: "https://api.github.com" }, "base_host_not_local"],
    ["public IP", { ...ON, WARDBY_SIM_BASE_URL: "http://8.8.8.8" }, "base_host_not_local"],
    ["private IP", { ...ON, WARDBY_SIM_BASE_URL: "http://10.0.0.5:8080" }, "base_host_not_local"],
    ["svc look-alike", { ...ON, WARDBY_SIM_BASE_URL: "http://sim.svc.example.com" }, "base_host_not_local"],
    ["NODE_ENV production", { ...ON, NODE_ENV: "production" }, "node_env_production"],
    [
      "another App key",
      {
        ...ON,
        GITHUB_APP_PRIVATE_KEY: generateKeyPairSync("rsa", { modulusLength: 2048 })
          .privateKey.export({ type: "pkcs1", format: "pem" })
          .toString(),
      },
      "github_app_key_not_simulator",
    ],
    [
      "garbage App key",
      { ...ON, GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nzzz\n-----END RSA PRIVATE KEY-----" },
      "github_app_key_not_simulator",
    ], // gitleaks:allow -- malformed test fixture
    [
      "real OAuth secret",
      { ...ON, GITHUB_APP_CLIENT_SECRET: "0123456789abcdef0123456789abcdef01234567" },
      "github_oauth_not_simulator",
    ],
    ["real Slack token", { ...ON, WARDBY_SLACK_BOT_TOKEN: "xoxb-1234-5678-abcdefghijkl" }, "slack_token_not_simulator"],
    [
      "real Jira token",
      { ...ON, WARDBY_SIM_BASE_URL: "https://localhost:8443", WARDBY_JIRA_API_TOKEN: "ATATT3xFfGF0abc" },
      "jira_token_not_simulator",
    ],
    ["Jira over http", { ...ON, WARDBY_JIRA_API_TOKEN: "sim-jira-token" }, "jira_needs_https"],
    ["public WARDBY_HOSTNAME", { ...ON, WARDBY_HOSTNAME: "app.example.com" }, "public_hostname"],
    ["public canonical URI", { ...ON, MCP_CANONICAL_URI: "https://app.example.com/mcp" }, "public_hostname"],
  ];
  for (const [name, env, reason] of cases) {
    it(`refuses: ${name} → ${reason}`, () => {
      expect(refusal(env)).toBe(reason);
    });
  }

  it("names only its reason: never the URL, a host, or a credential", () => {
    const secret = "hunter2-very-secret-password";
    for (const base of [`http://user:${secret}@localhost:8080`, `https://${secret}.example.com`]) {
      try {
        loadTestSimulators({ ...ON, WARDBY_SIM_BASE_URL: base });
        expect.unreachable();
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toMatch(/^test_simulators_refused:[a-z_]+$/);
        expect(message).not.toContain(secret);
        expect(JSON.stringify(error)).not.toContain(secret);
        expect((error as Error).cause).toBeUndefined();
      }
    }
  });

  it("starts with the simulator's own test key and simulator tokens on a loopback or cluster-local host", () => {
    const env = {
      ...ON,
      GITHUB_APP_PRIVATE_KEY: SIM_KEY,
      GITHUB_APP_CLIENT_SECRET: "sim-oauth",
      WARDBY_SLACK_BOT_TOKEN: "xoxb-sim-1",
      WARDBY_HOSTNAME: "localhost:8080",
      MCP_CANONICAL_URI: "http://127.0.0.1:8080/mcp",
    };
    const sims = loadTestSimulators(env)!;
    expect(sims.origin).toBe(BASE);
    expect(sims.base("github-api")).toBe(`${BASE}/github/api`);
    expect(sims.base("github-git")).toBe(`${BASE}/github/git`);
    expect(sims.base("slack")).toBe(`${BASE}/slack/api`);
    // A key passed with escaped newlines, as some secret stores hold it.
    expect(loadTestSimulators({ ...env, GITHUB_APP_PRIVATE_KEY: SIM_KEY.replaceAll("\n", "\\n") })).not.toBeNull();
    expect(
      loadTestSimulators({ ...ON, WARDBY_SIM_BASE_URL: "https://localhost:8443", WARDBY_JIRA_API_TOKEN: "sim-jira" }),
    ).not.toBeNull();
  });

  it("pins the simulator's key fingerprint to the committed fixture", () => {
    const der = createPublicKey(SIM_KEY).export({ type: "spki", format: "der" });
    expect(createHash("sha256").update(der).digest("hex")).toBe(SIMULATOR_GITHUB_APP_KEY_FINGERPRINT);
    expect(SIM_APP_KEY_FINGERPRINT).toBe(SIMULATOR_GITHUB_APP_KEY_FINGERPRINT);
  });

  it("knows loopback and cluster-local hosts", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "127.9.9.9",
      "::1",
      "[::1]",
      "wardby-sim",
      "sim.ns.svc",
      "sim.ns.svc.cluster.local",
      "LOCALHOST.",
    ]) {
      expect(isLocalSimulatorHost(host), host).toBe(true);
    }
    for (const host of [
      "",
      "128.0.0.1",
      "10.1.2.3",
      "::2",
      "fe80::1",
      "example.com",
      "svc",
      "a..svc",
      "x.svc.cluster.local.evil.com",
    ]) {
      expect(isLocalSimulatorHost(host), host).toBe(host === "svc");
    }
  });
});

describe("the simulator registry fetch", () => {
  const sims = loadTestSimulators(ON)!;
  const blocked = () => new Error("proxy_egress_blocked");

  it("rewrites each registry host to its simulator, keeping path and query", async () => {
    const fake = vi.fn(async () => new Response("ok"));
    const fetch = createSimulatorRegistryFetch(sims, blocked, fake);
    await fetch("https://registry.npmjs.org/@scope%2fpkg?x=1", { redirect: "error" });
    await fetch("https://pypi.org/simple/requests/");
    await fetch("https://files.pythonhosted.org/packages/a/b/c.whl");
    await fetch(new URL("https://api.osv.dev/v1/querybatch"), { method: "POST", body: "{}" });
    expect(fake.mock.calls.map((c) => (c as unknown[])[0])).toEqual([
      `${BASE}/npm/@scope%2fpkg?x=1`,
      `${BASE}/pypi/simple/requests/`,
      `${BASE}/pypi-files/packages/a/b/c.whl`,
      `${BASE}/osv/v1/querybatch`,
    ]);
    expect(fake.mock.calls.every((c) => ((c as unknown[])[1] as RequestInit).redirect === "error")).toBe(true);
  });

  it("refuses every other host, http, ports, credentials and followed redirects", async () => {
    const fake = vi.fn(async () => new Response("ok"));
    const fetch = createSimulatorRegistryFetch(sims, blocked, fake);
    for (const url of [
      "https://example.com/x",
      "http://registry.npmjs.org/x",
      "https://registry.npmjs.org:8443/x",
      "https://u:p@registry.npmjs.org/x",
      "https://registry.npmjs.org.evil.com/x",
      "https://api.github.com/x",
      `${BASE}/npm/x`,
      "not a url",
    ]) {
      await expect(fetch(url), url).rejects.toThrow("proxy_egress_blocked");
    }
    await expect(fetch("https://registry.npmjs.org/x", { redirect: "follow" })).rejects.toThrow("proxy_egress_blocked");
    expect(fake).not.toHaveBeenCalled();
  });
});
