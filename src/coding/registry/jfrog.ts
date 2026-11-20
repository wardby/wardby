/**
 * Operator configuration for a private JFrog Artifactory behind the coding
 * proxy's package registry. Everything here is non-secret (a URL, repo keys
 * and npm scopes), so the trusted host reads it too; the credential is a
 * separate `env:NAME` reference only the proxy resolves (jfrogCredentials).
 *
 * npm is scope-routed: names in the configured scopes come only from the
 * JFrog npm repo, every other name from public npm. PyPI replaces the public
 * index: the JFrog PyPI repo serves public packages too.
 *
 * With nothing set the result is undefined and behaviour is exactly the
 * public registries'.
 */
import { PACKAGE_SCOPE } from "./npm-lockfile.js";
import type { PrivateRegistry } from "./types.js";

export class JfrogConfigError extends Error {
  constructor(message: string) {
    super(`registry_jfrog_config_invalid: ${message}`);
  }
}

export interface JfrogRegistryConfig {
  /** Base URL with the context path, no trailing slash. */
  url: string;
  /** Lower-case host of `url`; the only host the credential is ever sent to. */
  host: string;
  npm?: { repo: string; scopes: readonly string[] };
  /** `trustAll`: every package the JFrog PyPI repo serves is allowed, without an allowlist entry. */
  pypi?: { repo: string; trustAll: boolean };
}

const REPO_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function setting(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function repoKey(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = setting(env, name);
  if (value === undefined) return undefined;
  if (!REPO_KEY.test(value)) throw new JfrogConfigError(`${name} must be a plain repository key, not a path or URL`);
  return value;
}

function baseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new JfrogConfigError("REGISTRY_JFROG_URL is not a valid URL");
  }
  if (url.protocol !== "https:") throw new JfrogConfigError("REGISTRY_JFROG_URL must be https");
  if (url.username || url.password) throw new JfrogConfigError("REGISTRY_JFROG_URL must not embed credentials");
  if (url.search || url.hash) throw new JfrogConfigError("REGISTRY_JFROG_URL must not have a query or fragment");
  return url;
}

/** The JFrog registry settings from `env`, or undefined when none is set.
 *  Throws a JfrogConfigError on an invalid or incomplete combination. */
export function loadJfrogRegistryConfig(env: NodeJS.ProcessEnv = process.env): JfrogRegistryConfig | undefined {
  const rawUrl = setting(env, "REGISTRY_JFROG_URL");
  const npmRepo = repoKey(env, "REGISTRY_JFROG_NPM_REPO");
  const pypiRepo = repoKey(env, "REGISTRY_JFROG_PYPI_REPO");
  const rawScopes = setting(env, "REGISTRY_JFROG_NPM_SCOPES");
  if (rawUrl === undefined) {
    if (npmRepo || pypiRepo || rawScopes || setting(env, "REGISTRY_JFROG_PYPI_TRUST_ALL"))
      throw new JfrogConfigError("a repository is set without REGISTRY_JFROG_URL");
    return undefined;
  }
  if (!npmRepo && !pypiRepo) throw new JfrogConfigError("REGISTRY_JFROG_URL is set without a repository");
  const url = baseUrl(rawUrl);
  const config: JfrogRegistryConfig = {
    url: `${url.origin}${url.pathname}`.replace(/\/+$/, ""),
    host: url.hostname.toLowerCase(),
  };
  if (npmRepo) {
    const scopes = (rawScopes ?? "")
      .split(",")
      .map((scope) => scope.trim())
      .filter((scope) => scope !== "");
    if (scopes.length === 0) throw new JfrogConfigError("REGISTRY_JFROG_NPM_REPO needs REGISTRY_JFROG_NPM_SCOPES");
    for (const scope of scopes)
      if (!PACKAGE_SCOPE.test(scope)) throw new JfrogConfigError(`"${scope}" is not an npm scope such as @acme`);
    config.npm = { repo: npmRepo, scopes: [...new Set(scopes)] };
  } else if (rawScopes) {
    throw new JfrogConfigError("REGISTRY_JFROG_NPM_SCOPES needs REGISTRY_JFROG_NPM_REPO");
  }
  const trustAll = setting(env, "REGISTRY_JFROG_PYPI_TRUST_ALL");
  if (trustAll !== undefined && trustAll !== "true" && trustAll !== "false")
    throw new JfrogConfigError("REGISTRY_JFROG_PYPI_TRUST_ALL must be true or false");
  if (trustAll === "true" && !pypiRepo)
    throw new JfrogConfigError("REGISTRY_JFROG_PYPI_TRUST_ALL needs REGISTRY_JFROG_PYPI_REPO");
  if (pypiRepo) config.pypi = { repo: pypiRepo, trustAll: trustAll === "true" };
  return config;
}

/** The private npm registry the adapter and the lockfile hooks are given. */
export function jfrogNpmRegistry(config: JfrogRegistryConfig | undefined): PrivateRegistry | undefined {
  return config?.npm ? { baseUrl: `${config.url}/api/npm/${config.npm.repo}/`, scopes: config.npm.scopes } : undefined;
}

/** The JFrog PyPI simple index, or undefined to use public PyPI. */
export function jfrogPypiIndex(config: JfrogRegistryConfig | undefined): string | undefined {
  return config?.pypi ? `${config.url}/api/pypi/${config.pypi.repo}/simple/` : undefined;
}

export interface JfrogCredentials {
  host: string;
  /** The `Authorization` header value (Basic). */
  authorization: string;
}

/** Resolves the proxy-only credential for `config` from `env:NAME`
 *  references (REGISTRY_UPSTREAM_USERNAME / _PASSWORD). Required: there is
 *  no anonymous access. Throws without echoing any value. */
export function loadJfrogCredentials(
  config: JfrogRegistryConfig | undefined,
  env: NodeJS.ProcessEnv = process.env,
): JfrogCredentials | undefined {
  const username = setting(env, "REGISTRY_UPSTREAM_USERNAME");
  const password = setting(env, "REGISTRY_UPSTREAM_PASSWORD");
  if (!config) {
    if (username || password)
      throw new JfrogConfigError("REGISTRY_UPSTREAM_USERNAME/PASSWORD are set but no JFrog repository is configured");
    return undefined;
  }
  if (!username || !password)
    throw new JfrogConfigError("REGISTRY_UPSTREAM_USERNAME and REGISTRY_UPSTREAM_PASSWORD are required");
  const resolve = (name: string, reference: string): string => {
    const match = /^env:([A-Z][A-Z0-9_]{0,127})$/.exec(reference);
    if (!match) throw new JfrogConfigError(`${name} must be an env:NAME reference`);
    const value = env[match[1]];
    if (!value) throw new JfrogConfigError(`${name} refers to ${match[1]}, which is not set`);
    return value;
  };
  const user = resolve("REGISTRY_UPSTREAM_USERNAME", username);
  const secret = resolve("REGISTRY_UPSTREAM_PASSWORD", password);
  return { host: config.host, authorization: `Basic ${Buffer.from(`${user}:${secret}`).toString("base64")}` };
}
