/**
 * Calling a provider's approved snapshots, and the read-only checks test_host_provider reports.
 * A report holds an operation, its repository, an outcome and a fixed code, so it can be shared
 * from a team whose host we can't reach, carrying nothing else.
 */
import type { PrismaClient, Secret } from "#prisma";
import { codeProviderOf, normalizeHostedRepository } from "../../coding/code-host.js";
import { loadTestSimulators, simulatorHostFetch } from "../../config/test-simulators.js";
import { parseSecretBrokerConfig } from "../../core/secret-broker-config.js";
import type { SecretEntry } from "../../core/secrets.js";
import { safeFetch } from "../../sandbox/safe-fetch.js";
import type { SecretCipher } from "../secrets/types.js";
import { invokeHostTool, type HostToolResult } from "./invoke.js";
import { HOST_OPERATIONS, isHostOperation, type HostOperation } from "./operations.js";
import { findCredential } from "./registry.js";

type StoredSecret = Pick<Secret, "ciphertext" | "broker">;

export interface LoadedProvider {
  name: string;
  apiHosts: string[];
  repositoryApiPath: string;
  permissionApiPath: string | null;
  permissionSecret: StoredSecret | null;
  credentials: { repositoryPattern: string; secret: StoredSecret }[];
  operations: { operation: string; code: string; paramsZod: string }[];
}

/**
 * The fetch for bound tools: the real one, or under WARDBY_TEST_SIMULATORS the simulator's. Under
 * the switch only `sim-` credentials are sent, as the switch refuses every other real credential.
 */
export function hostToolFetch(env: NodeJS.ProcessEnv = process.env): {
  fetchImpl?: typeof safeFetch;
  simulated: boolean;
} {
  const simulators = loadTestSimulators(env);
  return simulators ? { fetchImpl: simulatorHostFetch(simulators, safeFetch), simulated: true } : { simulated: false };
}

export async function loadProviderForCalls(db: PrismaClient, name: string): Promise<LoadedProvider | null> {
  const row = await db.hostProvider.findUnique({
    where: { name },
    include: { permissionSecret: true, credentials: { include: { secret: true } }, operations: true },
  });
  if (!row) return null;
  return {
    name: row.name,
    apiHosts: row.apiHosts,
    repositoryApiPath: row.repositoryApiPath,
    permissionApiPath: row.permissionApiPath,
    permissionSecret: row.permissionSecret,
    credentials: row.credentials,
    operations: row.operations,
  };
}

// No URL-encoding: callHostOperation only takes a repository in its normalized form, which admits only [A-Za-z0-9._-], and the request guard compares a raw prefix.
function encodePath(template: string, fields: Record<string, string>): string {
  return template.replace(/\{([a-z]+)\}/g, (_m, field: string) => fields[field]);
}

/** The repository is compared in its normalized form, so callers must pass one. */
export async function callHostOperation(
  provider: LoadedProvider,
  cipher: SecretCipher,
  repository: string,
  operation: HostOperation,
  fields: Record<string, unknown>,
  options: { fetchImpl?: typeof safeFetch; simulated?: boolean } = {},
): Promise<HostToolResult> {
  let ours = false;
  try {
    ours = normalizeHostedRepository(repository) === repository && codeProviderOf(repository) === provider.name;
  } catch {
    // Not a repository we can name: denied below.
  }
  if (!ours) return { ok: false, code: "host_tool_request_denied" };
  const snapshot = provider.operations.find((o) => o.operation === operation);
  if (!snapshot) return { ok: false, code: "host_tool_failed" };
  const path = repository.slice(`${provider.name}:`.length);
  const [workspace, repo] = path.split("/");
  const permission = HOST_OPERATIONS[operation].credential === "permission";
  const stored = permission ? provider.permissionSecret : (findCredential(provider.credentials, path)?.secret ?? null);
  const template = permission ? provider.permissionApiPath : provider.repositoryApiPath;
  if (!stored || !template) return { ok: false, code: "host_tool_no_credential" };

  const credential = async (): Promise<SecretEntry | undefined> => {
    const value = await cipher.decrypt(stored.ciphertext);
    if (options.simulated && !value.startsWith("sim-")) return undefined;
    return { value, broker: parseSecretBrokerConfig(stored.broker) };
  };
  return invokeHostTool({
    provider: provider.name,
    operation,
    snapshot,
    params: { ...fields, workspace, repo, repository: path },
    apiHosts: provider.apiHosts,
    pathPrefix: encodePath(template, { repository: path, workspace, repo }),
    credential,
    fetchImpl: options.fetchImpl,
  });
}

export interface SelfTestInput {
  repository: string;
  pullRequest?: number;
  headRef?: string;
  ref?: string;
  accountId?: string;
}

export interface SelfTestReport {
  provider: string;
  repository: string;
  mode: "permission" | "allowlist";
  results: { operation: string; outcome: "pass" | "fail" | "skipped"; code?: string }[];
}

export async function selfTestHostProvider(
  provider: LoadedProvider,
  cipher: SecretCipher,
  input: SelfTestInput,
  options: { fetchImpl?: typeof safeFetch; simulated?: boolean } = {},
): Promise<SelfTestReport> {
  const repository = normalizeHostedRepository(input.repository);
  if (codeProviderOf(repository) !== provider.name) throw new Error("host_provider_repository_mismatch");

  const results: SelfTestReport["results"] = [];
  const skip = (operation: string, code: string) => results.push({ operation, outcome: "skipped", code });
  const check = async (operation: HostOperation, fields: Record<string, unknown>): Promise<HostToolResult> => {
    const result = await callHostOperation(provider, cipher, repository, operation, fields, options);
    results.push(result.ok ? { operation, outcome: "pass" } : { operation, outcome: "fail", code: result.code });
    return result;
  };
  const bound = (name: HostOperation) => provider.operations.some((o) => o.operation === name);

  // The pull request comes first: its head is the ref for the checks that need one.
  let ref = input.ref;
  const number = input.pullRequest;
  if (!bound("getPullRequest")) skip("getPullRequest", "not_bound");
  else if (number === undefined) skip("getPullRequest", "needs_pull_request");
  else {
    const pr = await check("getPullRequest", { number });
    if (pr.ok) ref ??= (pr.value as { headSha: string }).headSha;
  }

  for (const operation of ["listPullRequestFiles", "getDiff", "listComments"] as const) {
    if (!bound(operation)) skip(operation, "not_bound");
    else if (number === undefined) skip(operation, "needs_pull_request");
    else await check(operation, { number });
  }

  if (!bound("findPullRequest")) skip("findPullRequest", "not_bound");
  else if (input.headRef === undefined) skip("findPullRequest", "needs_head_ref");
  else await check("findPullRequest", { headRef: input.headRef });

  for (const [operation, fields] of [
    ["readFile", { path: "README.md" }],
    ["listFiles", { path: "" }],
    ["listCommitStatuses", {}],
  ] as const) {
    if (!bound(operation)) skip(operation, "not_bound");
    else if (ref === undefined) skip(operation, "needs_ref");
    else await check(operation, { ref, ...fields });
  }

  const mode = provider.permissionSecret ? "permission" : "allowlist";
  if (mode === "allowlist") skip("getRepositoryPermission", "allowlist_mode");
  else if (!bound("getRepositoryPermission")) skip("getRepositoryPermission", "not_bound");
  else if (input.accountId === undefined) skip("getRepositoryPermission", "needs_account");
  else await check("getRepositoryPermission", { accountId: input.accountId });

  for (const { operation } of provider.operations) {
    if (isHostOperation(operation) && !HOST_OPERATIONS[operation].readOnly) skip(operation, "not_read_only");
  }
  return { provider: provider.name, repository, mode, results };
}
