/**
 * WARDBY_TEST_SIMULATORS: the release regression suite's switch that points wardby's
 * GitHub API base, GitHub clone URLs, the Slack and Jira API bases and the package
 * registry upstreams (npm, PyPI, OSV) and the model upstreams (the coding proxy's, and the
 * native Anthropic and OpenAI clients') at one simulator (tools/wardby-sim). Test only.
 *
 * Model requests never carry a credential to the simulator: the provider clients are built with
 * a placeholder key, and every model request goes through a fetch that drops each credential
 * header (createCredentialFreeFetch). Bedrock is refused under the switch (AWS-signed requests
 * cannot be pointed at the simulator).
 *
 * It is a token-exfiltration path by design: with it on, the GitHub App JWT and
 * installation tokens, the Slack bot token and the Jira token all go to whatever host
 * WARDBY_SIM_BASE_URL names. So it is all-or-nothing and refuses to start, with
 * `test_simulators_refused:<reason>` (the reason only, never a URL or a credential), when:
 *
 * - only one of WARDBY_TEST_SIMULATORS=1 and WARDBY_SIM_BASE_URL is set, or the flag is not "1";
 * - the image was built for release (WARDBY_TEST_SIMULATORS_ALLOWED=0, baked at build time);
 * - the base URL is not a bare http(s) origin, carries credentials, or names a host that is
 *   neither loopback (127.0.0.0/8, ::1, localhost) nor cluster-local (*.svc,
 *   *.svc.cluster.local, a single-label name);
 * - production configuration is present: NODE_ENV=production; a GitHub App key that is not
 *   the simulator's published test key (by public-key fingerprint); a public WARDBY_HOSTNAME
 *   or MCP_CANONICAL_URI; a Slack bot token, Jira token or GitHub App client secret that is
 *   not a simulator token (xoxb-sim-…, sim-…, sim-…);
 * - Jira is configured but the simulator is plain http (Jira's https-only rule stays);
 * - the load-test mock upstream (WARDBY_LOAD_TEST / WARDBY_CODING_PROXY_MOCK_UPSTREAM) is also set.
 */
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { logger } from "../core/logger.js";

/** SHA-256 (hex) of the SPKI DER of the simulator's test GitHub App key (tools/wardby-sim/fixtures). */
export const SIMULATOR_GITHUB_APP_KEY_FINGERPRINT = "dac6c80f55da011bbd2ed5868c61972f778853069f125946964e093e51a7d141";

/** Where each simulated service is mounted under WARDBY_SIM_BASE_URL. */
export const SIMULATOR_PREFIXES = {
  "github-api": "/github/api",
  "github-git": "/github/git",
  slack: "/slack/api",
  jira: "/jira",
  npm: "/npm",
  pypi: "/pypi",
  "pypi-files": "/pypi-files",
  osv: "/osv",
  /** The scripted model (tools/wardby-sim/src/model): /model/anthropic and /model/openai. */
  model: "/model",
} as const;

export type SimulatedService = keyof typeof SIMULATOR_PREFIXES;

/** The real upstream host each registry simulator stands in for. */
export const SIMULATED_REGISTRY_HOSTS: Readonly<Record<string, SimulatedService>> = {
  "registry.npmjs.org": "npm",
  "pypi.org": "pypi",
  "files.pythonhosted.org": "pypi-files",
  "api.osv.dev": "osv",
};

export type TestSimulatorsRefusal =
  | "partial"
  | "flag_value"
  | "release_image"
  | "base_url_invalid"
  | "base_url_credentials"
  | "base_url_form"
  | "base_host_not_local"
  | "node_env_production"
  | "github_app_key_not_simulator"
  | "github_oauth_not_simulator"
  | "slack_token_not_simulator"
  | "jira_token_not_simulator"
  | "jira_needs_https"
  | "public_hostname"
  | "model_mock_conflict"
  | "ca_file_invalid"
  | "bedrock_not_simulated";

export class TestSimulatorsRefused extends Error {
  constructor(readonly reason: TestSimulatorsRefusal) {
    super(`test_simulators_refused:${reason}`);
    this.name = "TestSimulatorsRefused";
  }
}

export interface TestSimulators {
  /**
   * WARDBY_SIM_CA_FILE: the simulator's throwaway CA (deploy/kind-coding/sim-ca.sh), trusted by the
   * git commands wardby runs (GIT_SSL_CAINFO) so its https-only git can reach the simulator's
   * git server. Node itself trusts it through NODE_EXTRA_CA_CERTS, set by the test harness.
   */
  caFile?: string;
  /** The simulator's origin, without a trailing slash ("http://wardby-sim.wardby-sim.svc:8080"). */
  origin: string;
  /** The host, for the startup warning (never carries credentials: those are refused). */
  host: string;
  base(service: SimulatedService): string;
}

/** Loopback or cluster-local: the only hosts the simulator may live on. */
export function isLocalSimulatorHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (host === "") return false;
  if (host === "localhost" || host === "::1") return true;
  const ipVersion = isIP(host);
  if (ipVersion === 4) return host.split(".")[0] === "127";
  if (ipVersion === 6) return false;
  if (!/^[a-z0-9.-]+$/.test(host) || host.split(".").some((label) => label === "")) return false;
  if (!host.includes(".")) return true;
  return host.endsWith(".svc") || host.endsWith(".svc.cluster.local");
}

function localUrlOrUnset(value: string | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return true;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
    return isLocalSimulatorHost(url.hostname);
  } catch {
    return false;
  }
}

function keyFingerprint(pem: string): string | null {
  try {
    const normalized = pem.includes("\\n") && !pem.includes("\n") ? pem.replaceAll("\\n", "\n") : pem;
    const der = createPublicKey(createPrivateKey(normalized)).export({ type: "spki", format: "der" });
    return createHash("sha256").update(der).digest("hex");
  } catch {
    return null;
  }
}

/**
 * The simulators, or null when the switch is off. Throws TestSimulatorsRefused on any
 * refusal; with the switch off nothing here reads or changes any other setting.
 */
export function loadTestSimulators(env: NodeJS.ProcessEnv = process.env): TestSimulators | null {
  const flag = env.WARDBY_TEST_SIMULATORS;
  const rawBase = env.WARDBY_SIM_BASE_URL;
  if (flag === undefined && rawBase === undefined) return null;
  if (flag === undefined || rawBase === undefined) throw new TestSimulatorsRefused("partial");
  if (flag !== "1") throw new TestSimulatorsRefused("flag_value");
  if (env.WARDBY_TEST_SIMULATORS_ALLOWED === "0") throw new TestSimulatorsRefused("release_image");

  let url: URL;
  try {
    url = new URL(rawBase.trim());
  } catch {
    throw new TestSimulatorsRefused("base_url_invalid");
  }
  if (url.username || url.password) throw new TestSimulatorsRefused("base_url_credentials");
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.pathname !== "/" || url.search || url.hash) {
    throw new TestSimulatorsRefused("base_url_form");
  }
  if (!isLocalSimulatorHost(url.hostname)) throw new TestSimulatorsRefused("base_host_not_local");

  if (env.NODE_ENV === "production") throw new TestSimulatorsRefused("node_env_production");
  const key = env.GITHUB_APP_PRIVATE_KEY?.trim();
  if (key && keyFingerprint(key) !== SIMULATOR_GITHUB_APP_KEY_FINGERPRINT) {
    throw new TestSimulatorsRefused("github_app_key_not_simulator");
  }
  const oauthSecret = env.GITHUB_APP_CLIENT_SECRET?.trim();
  if (oauthSecret && !oauthSecret.startsWith("sim-")) throw new TestSimulatorsRefused("github_oauth_not_simulator");
  const slackToken = env.WARDBY_SLACK_BOT_TOKEN?.trim();
  if (slackToken && !slackToken.startsWith("xoxb-sim-")) throw new TestSimulatorsRefused("slack_token_not_simulator");
  const jiraToken = env.WARDBY_JIRA_API_TOKEN?.trim();
  if (jiraToken && !jiraToken.startsWith("sim-")) throw new TestSimulatorsRefused("jira_token_not_simulator");
  if (jiraToken && url.protocol !== "https:") throw new TestSimulatorsRefused("jira_needs_https");
  // The load-test mock upstream answers model requests itself: one model seam at a time.
  if (env.WARDBY_LOAD_TEST !== undefined || env.WARDBY_CODING_PROXY_MOCK_UPSTREAM !== undefined) {
    throw new TestSimulatorsRefused("model_mock_conflict");
  }
  if (!localUrlOrUnset(env.WARDBY_HOSTNAME) || !localUrlOrUnset(env.MCP_CANONICAL_URI)) {
    throw new TestSimulatorsRefused("public_hostname");
  }

  const caFile = env.WARDBY_SIM_CA_FILE?.trim();
  if (caFile !== undefined && !validCaFile(caFile)) throw new TestSimulatorsRefused("ca_file_invalid");

  const origin = url.origin;
  return {
    origin,
    host: url.host,
    ...(caFile ? { caFile } : {}),
    base: (service) => `${origin}${SIMULATOR_PREFIXES[service]}`,
  };
}

function validCaFile(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    return readFileSync(path, "utf8").includes("-----BEGIN CERTIFICATE-----");
  } catch {
    return false;
  }
}

/** Extra environment for the git commands wardby runs: the simulator's CA, under the switch only. */
export function simulatorGitEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const caFile = loadTestSimulators(env)?.caFile;
  return caFile ? { GIT_SSL_CAINFO: caFile } : {};
}

/** The simulator's base for one service, or null when the switch is off (throws on a refusal). */
export function testSimulatorBase(service: SimulatedService, env: NodeJS.ProcessEnv = process.env): string | null {
  return loadTestSimulators(env)?.base(service) ?? null;
}

/**
 * The registry upstream fetch under the switch: each real registry host (npm, PyPI, its file
 * host, OSV) is rewritten to its simulator, with the same request; every other host is
 * refused like the pinned fetch refuses it (`blocked`). Only https upstream URLs are taken,
 * as the pinned fetch takes them.
 */
export function createSimulatorRegistryFetch(
  simulators: TestSimulators,
  blocked: () => Error,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init = {}) => {
    if (typeof input !== "string" && !(input instanceof URL)) throw blocked();
    let parsed: URL;
    try {
      parsed = new URL(input.toString());
    } catch {
      throw blocked();
    }
    const service = SIMULATED_REGISTRY_HOSTS[parsed.hostname.toLowerCase()];
    if (parsed.protocol !== "https:" || parsed.port || parsed.username || parsed.password || !service) throw blocked();
    if (init.redirect && init.redirect !== "error") throw blocked();
    return fetchImpl(`${simulators.base(service)}${parsed.pathname}${parsed.search}`, { ...init, redirect: "error" });
  };
}

/**
 * Process start-up: refuses (throws) on any refusal, and with the switch on logs one loud
 * warning naming the simulator's host only.
 */
export function startupTestSimulators(component: string, env: NodeJS.ProcessEnv = process.env): TestSimulators | null {
  const simulators = loadTestSimulators(env);
  if (simulators) {
    logger.warn(
      { module: "test-simulators", event: "test_simulators.enabled", component, host: simulators.host },
      "TEST SIMULATORS ENABLED: GitHub, Slack, Jira and package-registry traffic goes to the simulator. Never use this on a real deployment.",
    );
  }
  return simulators;
}

/** Header names that can carry a credential; none of them reaches the simulator's model endpoints. */
const CREDENTIAL_HEADER =
  /authorization|api[-_]?key|token|secret|cookie|organization|project|credential|signature|session/i;

/** A placeholder the provider SDKs require; createCredentialFreeFetch drops it before sending. */
export const SIMULATOR_PLACEHOLDER_API_KEY = "sim-placeholder-not-a-credential";

/**
 * A fetch to the simulator only: drops every header that can carry a credential, and refuses
 * any URL outside the simulator's origin (`blocked`).
 */
export function createCredentialFreeFetch(
  simulators: TestSimulators,
  blocked: () => Error,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init = {}) => {
    const url = input instanceof Request ? input.url : input.toString();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw blocked();
    }
    if (parsed.origin !== simulators.origin || parsed.username || parsed.password) throw blocked();
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    for (const name of [...headers.keys()]) if (CREDENTIAL_HEADER.test(name)) headers.delete(name);
    const body = init.body ?? (input instanceof Request ? await input.text() : undefined);
    return fetchImpl(parsed.toString(), {
      ...init,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: "error",
    });
  };
}

/** The real model upstream each scripted model path stands in for (the coding proxy's two). */
const SIMULATED_MODEL_URLS: readonly [string, string][] = [
  ["https://api.openai.com/v1/responses", "/openai/v1/responses"],
  ["https://api.anthropic.com/v1/messages", "/anthropic/v1/messages"],
];

/**
 * The coding proxy's model upstream under the switch: the OpenAI Responses and Anthropic
 * Messages endpoints go to the scripted model, with no credential; every other URL is refused.
 */
export function createSimulatorModelFetch(
  simulators: TestSimulators,
  blocked: () => Error,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  const send = createCredentialFreeFetch(simulators, blocked, fetchImpl);
  return async (input, init = {}) => {
    if (typeof input !== "string" && !(input instanceof URL)) throw blocked();
    let parsed: URL;
    try {
      parsed = new URL(input.toString());
    } catch {
      throw blocked();
    }
    const match = SIMULATED_MODEL_URLS.find(([real]) => `${parsed.origin}${parsed.pathname}` === real);
    if (!match || parsed.username || parsed.password) throw blocked();
    return send(`${simulators.base("model")}${match[1]}${parsed.search}`, init);
  };
}

/**
 * Client options for a native provider SDK under the switch (null when off): the scripted
 * model's base for that provider, a placeholder key, and the credential-free fetch.
 */
export function simulatorModelClientOptions(
  provider: "anthropic" | "openai",
  env: NodeJS.ProcessEnv = process.env,
): { baseURL: string; apiKey: string; fetch: typeof globalThis.fetch } | null {
  const simulators = loadTestSimulators(env);
  if (!simulators) return null;
  return {
    baseURL: `${simulators.base("model")}${provider === "anthropic" ? "/anthropic" : "/openai/v1"}`,
    apiKey: SIMULATOR_PLACEHOLDER_API_KEY,
    fetch: createCredentialFreeFetch(simulators, () => new Error("test_simulators_model_egress_blocked")),
  };
}

/** Bedrock signs with AWS credentials and cannot be pointed at the simulator: refused under the switch. */
export function refuseBedrockUnderTestSimulators(env: NodeJS.ProcessEnv = process.env): void {
  if (loadTestSimulators(env)) throw new TestSimulatorsRefused("bedrock_not_simulated");
}
