import { createPrivateKey } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { normalizeGitHubRepository, normalizeGitRef } from "../../coding/protocol.js";

const DEFAULT_API_BASE_URL = "https://api.github.com";
const DEFAULT_API_VERSION = "2026-03-10";
const RUN_MARKER_PREFIX = "<!-- wardby:";
const STATUS_COMMENT_MARKER_PREFIX = "<!-- wardby-status:";
const CONTINUATION_CHECK_RUN_NAME = "wardby/continuation";
/** Mirrors coding/protocol.ts's tagSchema — validated independently here since this is where it reaches GitHub. */
const SAFE_PULL_REQUEST_TAG = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,31}$/;
/** Mirrors the runId shape validated elsewhere (coding/protocol.ts, git.ts) — validated independently here too. */
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SAFE_COMMIT_SHA = /^[0-9a-f]{40}$/;

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  apiBaseUrl?: string;
  apiVersion?: string;
}

export interface PullRequestTestResult {
  command: string;
  outcome: "passed" | "failed" | "skipped";
}

/** One package the registry proxy served during the run (RegistryFetch outcome "served"). */
export interface PackageReport {
  ecosystem: string;
  name: string;
  version: string;
}

/** One package the registry proxy refused during the run (RegistryFetch outcome "refused"). */
export interface PackageRefusal {
  ecosystem: string;
  name: string;
  reason: string;
}

export interface PullRequestInput {
  runId: string;
  repository: string;
  baseRef: string;
  headRef: string;
  /** Already-validated/redacted agent-authored fields (coding/protocol.ts); optional for callers with none. */
  summary?: string;
  tests?: readonly PullRequestTestResult[];
  tag?: string;
  /** Deduplicated by the caller isn't required — pullRequestBody dedupes itself (ecosystem+name+version / +reason). */
  packages?: readonly PackageReport[];
  packageRefusals?: readonly PackageRefusal[];
  /**
   * A continuation re-finds the PR its root run opened, and a person may
   * have marked that PR ready for review since. The push has already updated
   * it, so it is accepted as found instead of failing the run as
   * `github_pull_request_not_draft`. A PR this client creates is always a
   * draft either way; unset (a fresh run), only a draft PR is accepted.
   */
  acceptReadyForReview?: boolean;
}

export interface PullRequestResult {
  number: number;
  url: string;
}

/** See VcsProvider.notifyContinuationStarted/Finished (types.ts) — these back that GitHub-specific mechanism. */
export interface ContinuationStatusCommentInput {
  /** This continuation round's own run id — the comment's identity/marker key. */
  runId: string;
  /** The run whose PR this belongs to (used only to re-find the PR via the existing marker lookup). */
  rootRunId: string;
  repository: string;
  baseRef: string;
  headRef: string;
  body: string;
}

export interface ContinuationCheckRunInput {
  repository: string;
  headSha: string;
  /** Stored as the check run's external_id — the re-lookup key, so no numeric id needs to be cached anywhere. */
  runId: string;
}

export interface ContinuationCheckRunCompleteInput extends ContinuationCheckRunInput {
  outcome: "succeeded" | "failed";
}

export interface GitHubRepositoryAccess {
  withRepositoryToken<T>(repository: string, action: (token: string) => Promise<T>): Promise<T>;
  createOrFindDraftPullRequest(input: PullRequestInput): Promise<PullRequestResult>;
  /** Creates the status comment if none exists yet for this run, else updates it. */
  upsertContinuationStatusComment(input: ContinuationStatusCommentInput): Promise<void>;
  /** Updates the status comment if one already exists for this run; a no-op otherwise (never creates). */
  updateContinuationStatusComment(input: ContinuationStatusCommentInput): Promise<void>;
  /** Creates an in-progress check run if none exists yet for this run+commit; a no-op if one already does. */
  createContinuationCheckRun(input: ContinuationCheckRunInput): Promise<void>;
  /** Completes the check run if one exists for this run+commit; a no-op otherwise (never creates). */
  completeContinuationCheckRun(input: ContinuationCheckRunCompleteInput): Promise<void>;
}

type Fetch = typeof globalThis.fetch;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("github_api_invalid_response");
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error("github_api_invalid_response");
  return Number(value);
}

function safeApiError(response: Response): Error {
  const requestId = response.headers.get("x-github-request-id");
  return new Error(`github_api_error:${response.status}${requestId ? `:${requestId}` : ""}`);
}

/** Accepts bounded opaque installation tokens without allowing control characters. */
export function isSafeGitHubInstallationToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 20 &&
    Buffer.byteLength(value, "utf8") <= 512 &&
    /^[A-Za-z0-9._-]+$/.test(value)
  );
}

function pullRequestTitle(input: PullRequestInput): string {
  return input.tag ? `[${input.tag}] Wardby run ${input.runId}` : `Wardby run ${input.runId}`;
}

/**
 * Package names/versions/reasons come from registry metadata, not from
 * anything Wardby validated, and land inside inline code spans in the PR
 * body. A backtick or newline in one of those fields could break out of the
 * span or the line structure, so any entry containing either is dropped
 * rather than escaped (npm/PyPI names can't contain backticks in practice,
 * so this should never trigger — it's a cheap belt-and-suspenders guard).
 */
function isSafeMarkdownFragment(value: string): boolean {
  return !value.includes("`") && !value.includes("\n") && !value.includes("\r");
}

/** At most this many packages, and separately this many refusals, are listed
 *  in a PR body; the rest are counted in a "…and N more" line pointing at
 *  get_run, which returns the full list. */
export const MAX_PR_PACKAGE_LINES = 100;
/** A hard ceiling on each list's rendered size, whatever the entries
 *  contain, so the section can never push the body past GitHub's limit. */
const MAX_PR_PACKAGE_LIST_CHARS = 16 * 1024;

/** Renders at most MAX_PR_PACKAGE_LINES lines (and at most
 *  MAX_PR_PACKAGE_LIST_CHARS characters) of `lines`, then a count of the rest. */
function cappedList(lines: readonly string[]): string[] {
  const shown: string[] = [];
  let chars = 0;
  for (const line of lines.slice(0, MAX_PR_PACKAGE_LINES)) {
    if (chars + line.length + 1 > MAX_PR_PACKAGE_LIST_CHARS) break;
    shown.push(line);
    chars += line.length + 1;
  }
  const more = lines.length - shown.length;
  return more > 0 ? [...shown, `- …and ${more} more — see get_run for the full list`] : shown;
}

function packagesSection(input: PullRequestInput): string | undefined {
  const packages = [
    ...new Map(
      (input.packages ?? [])
        .filter(
          (pkg) =>
            isSafeMarkdownFragment(pkg.ecosystem) &&
            isSafeMarkdownFragment(pkg.name) &&
            isSafeMarkdownFragment(pkg.version),
        )
        .map((pkg) => [`${pkg.ecosystem}\0${pkg.name}\0${pkg.version}`, pkg] as const),
    ).values(),
  ];
  const refusals = [
    ...new Map(
      (input.packageRefusals ?? [])
        .filter(
          (refusal) =>
            isSafeMarkdownFragment(refusal.ecosystem) &&
            isSafeMarkdownFragment(refusal.name) &&
            isSafeMarkdownFragment(refusal.reason),
        )
        .map((refusal) => [`${refusal.ecosystem}\0${refusal.name}\0${refusal.reason}`, refusal] as const),
    ).values(),
  ];
  if (packages.length === 0 && refusals.length === 0) return undefined;
  return [
    "<details>",
    `<summary>Packages installed during this run (${packages.length})</summary>`,
    "",
    ...cappedList(packages.map((pkg) => `- ${pkg.ecosystem} \`${pkg.name}@${pkg.version}\``)),
    ...(refusals.length > 0
      ? [
          "",
          "**Refused:**",
          ...cappedList(refusals.map((refusal) => `- ${refusal.ecosystem} \`${refusal.name}\`: ${refusal.reason}`)),
        ]
      : []),
    "</details>",
  ].join("\n");
}

/** The hidden run marker stays first and unconditional: createOrFindDraftPullRequest's idempotent lookup depends on it. */
export function pullRequestBody(input: PullRequestInput): string {
  const sections = [`${RUN_MARKER_PREFIX}${input.runId} -->`];
  if (input.summary) sections.push(input.summary);
  if (input.tests?.length) {
    sections.push(["**Tests:**", ...input.tests.map((test) => `- \`${test.command}\`: ${test.outcome}`)].join("\n"));
  }
  // The packages section is informational: a failure rendering it (e.g. a
  // malformed report) omits the section and never fails finalization.
  try {
    const packages = packagesSection(input);
    if (packages) sections.push(packages);
  } catch {
    // omitted
  }
  return sections.join("\n\n");
}

/** The hidden marker stays first and unconditional: findStatusComment's lookup depends on it. */
function statusCommentBody(runId: string, body: string): string {
  return `${STATUS_COMMENT_MARKER_PREFIX}${runId} -->\n\n${body}`;
}

function normalizeApiBaseUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "api.github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("github_api_base_url_invalid");
  }
  return url.toString().replace(/\/$/, "");
}

function normalizePrivateKey(value: string): string {
  return value.includes("\\n") && !value.includes("\n") ? value.replaceAll("\\n", "\n") : value;
}

export class GitHubAppClient implements GitHubRepositoryAccess {
  private readonly apiBaseUrl: string;
  private readonly apiVersion: string;

  constructor(
    private readonly config: GitHubAppConfig,
    private readonly fetchImpl: Fetch = globalThis.fetch,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!/^[1-9]\d*$/.test(config.appId)) throw new Error("github_app_id_invalid");
    if (!config.privateKey.trim()) throw new Error("github_app_private_key_invalid");
    this.apiBaseUrl = normalizeApiBaseUrl(config.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    this.apiVersion = config.apiVersion ?? DEFAULT_API_VERSION;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(this.apiVersion)) throw new Error("github_api_version_invalid");
  }

  async withRepositoryToken<T>(repository: string, action: (token: string) => Promise<T>): Promise<T> {
    const normalized = normalizeGitHubRepository(repository);
    const token = await this.mintRepositoryToken(normalized);
    try {
      return await action(token);
    } finally {
      await this.revokeToken(token).catch(() => undefined);
    }
  }

  /**
   * Isolated from withRepositoryToken on purpose: "Checks: write" is a
   * genuinely distinct GitHub App permission from contents/pull_requests
   * (confirmed empirically). Minting it separately means an ungranted-permission
   * failure here can only ever disable the check-run mechanism, never the
   * real git push, PR, or status comment. (Status comments, below, do NOT
   * need this treatment: PR-comment writes work fine on the existing
   * contents/pull_requests token -- confirmed empirically after "Issues:
   * write" alone, on its own isolated token, kept returning 403 "Resource
   * not accessible by integration" even once granted; commenting on a PR
   * apparently isn't gated the same way a genuine issue comment might be.)
   */
  private async withChecksToken<T>(repository: string, action: (token: string) => Promise<T>): Promise<T> {
    const normalized = normalizeGitHubRepository(repository);
    const token = await this.mintChecksToken(normalized);
    try {
      return await action(token);
    } finally {
      await this.revokeToken(token).catch(() => undefined);
    }
  }

  async upsertContinuationStatusComment(input: ContinuationStatusCommentInput): Promise<void> {
    const repository = normalizeGitHubRepository(input.repository);
    const baseRef = normalizeGitRef(input.baseRef);
    const headRef = normalizeGitRef(input.headRef);
    if (!SAFE_RUN_ID.test(input.runId) || !SAFE_RUN_ID.test(input.rootRunId)) {
      throw new Error("github_status_comment_input_invalid");
    }
    await this.withRepositoryToken(repository, async (token) => {
      const pr = await this.findPullRequest(token, {
        runId: input.rootRunId,
        repository,
        baseRef,
        headRef,
        acceptReadyForReview: true,
      });
      if (!pr) return;
      const existing = await this.findStatusComment(token, repository, pr.number, input.runId);
      const [owner, name] = repository.split("/");
      const body = statusCommentBody(input.runId, input.body);
      if (existing) {
        await this.requestJson(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/comments/${existing.id}`,
          token,
          { method: "PATCH", body: JSON.stringify({ body }) },
          [200],
        );
      } else {
        await this.requestJson(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${pr.number}/comments`,
          token,
          { method: "POST", body: JSON.stringify({ body }) },
          [201],
        );
      }
    });
  }

  async updateContinuationStatusComment(input: ContinuationStatusCommentInput): Promise<void> {
    const repository = normalizeGitHubRepository(input.repository);
    const baseRef = normalizeGitRef(input.baseRef);
    const headRef = normalizeGitRef(input.headRef);
    if (!SAFE_RUN_ID.test(input.runId) || !SAFE_RUN_ID.test(input.rootRunId)) {
      throw new Error("github_status_comment_input_invalid");
    }
    await this.withRepositoryToken(repository, async (token) => {
      const pr = await this.findPullRequest(token, {
        runId: input.rootRunId,
        repository,
        baseRef,
        headRef,
        acceptReadyForReview: true,
      });
      if (!pr) return;
      const existing = await this.findStatusComment(token, repository, pr.number, input.runId);
      if (!existing) return;
      const [owner, name] = repository.split("/");
      await this.requestJson(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/comments/${existing.id}`,
        token,
        { method: "PATCH", body: JSON.stringify({ body: statusCommentBody(input.runId, input.body) }) },
        [200],
      );
    });
  }

  async createContinuationCheckRun(input: ContinuationCheckRunInput): Promise<void> {
    const repository = normalizeGitHubRepository(input.repository);
    if (!SAFE_RUN_ID.test(input.runId) || !SAFE_COMMIT_SHA.test(input.headSha)) {
      throw new Error("github_check_run_input_invalid");
    }
    await this.withChecksToken(repository, async (token) => {
      const existing = await this.findCheckRun(token, repository, input.headSha, input.runId);
      if (existing) return;
      const [owner, name] = repository.split("/");
      await this.requestJson(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/check-runs`,
        token,
        {
          method: "POST",
          body: JSON.stringify({
            name: CONTINUATION_CHECK_RUN_NAME,
            head_sha: input.headSha,
            status: "in_progress",
            external_id: input.runId,
          }),
        },
        [201],
      );
    });
  }

  async completeContinuationCheckRun(input: ContinuationCheckRunCompleteInput): Promise<void> {
    const repository = normalizeGitHubRepository(input.repository);
    if (!SAFE_RUN_ID.test(input.runId) || !SAFE_COMMIT_SHA.test(input.headSha)) {
      throw new Error("github_check_run_input_invalid");
    }
    await this.withChecksToken(repository, async (token) => {
      const existing = await this.findCheckRun(token, repository, input.headSha, input.runId);
      if (!existing) return;
      const [owner, name] = repository.split("/");
      await this.requestJson(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/check-runs/${existing.id}`,
        token,
        {
          method: "PATCH",
          body: JSON.stringify({
            status: "completed",
            conclusion: input.outcome === "succeeded" ? "success" : "failure",
          }),
        },
        [200],
      );
    });
  }

  async createOrFindDraftPullRequest(input: PullRequestInput): Promise<PullRequestResult> {
    const repository = normalizeGitHubRepository(input.repository);
    const baseRef = normalizeGitRef(input.baseRef);
    const headRef = normalizeGitRef(input.headRef);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.runId) || headRef !== `wardby/run-${input.runId}`) {
      throw new Error("github_pull_request_input_invalid");
    }
    if (input.tag !== undefined && !SAFE_PULL_REQUEST_TAG.test(input.tag)) {
      throw new Error("github_pull_request_tag_invalid");
    }

    return this.withRepositoryToken(repository, async (token) => {
      const existing = await this.findPullRequest(token, { ...input, repository, baseRef, headRef });
      if (existing) return existing;

      const [owner, name] = repository.split("/");
      const response = await this.requestJson(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls`,
        token,
        {
          method: "POST",
          body: JSON.stringify({
            title: pullRequestTitle(input),
            head: headRef,
            base: baseRef,
            body: pullRequestBody(input),
            draft: true,
          }),
        },
        [201, 422],
      );
      if (response.status === 201) return this.parsePullRequest(await response.json(), repository);

      const raced = await this.findPullRequest(token, { ...input, repository, baseRef, headRef });
      if (raced) return raced;
      throw safeApiError(response);
    });
  }

  private async appJwt(): Promise<string> {
    let keyObject;
    try {
      keyObject = createPrivateKey(normalizePrivateKey(this.config.privateKey));
    } catch {
      throw new Error("github_app_private_key_invalid");
    }
    const pkcs8 = keyObject.export({ type: "pkcs8", format: "pem" }).toString();
    const key = await importPKCS8(pkcs8, "RS256");
    const now = Math.floor(this.now().getTime() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuedAt(now - 60)
      .setExpirationTime(now + 9 * 60)
      .setIssuer(this.config.appId)
      .sign(key);
  }

  private async mintRepositoryToken(repository: string): Promise<string> {
    return this.mintScopedToken(
      repository,
      { contents: "write", pull_requests: "write" },
      (name, level) =>
        (name === "contents" && level === "write") ||
        (name === "pull_requests" && level === "write") ||
        (name === "metadata" && level === "read"),
    );
  }

  private async mintChecksToken(repository: string): Promise<string> {
    return this.mintScopedToken(
      repository,
      { checks: "write" },
      (name, level) => (name === "checks" && level === "write") || (name === "metadata" && level === "read"),
    );
  }

  /**
   * Shared installation-token mint: requests exactly `permissions`, then
   * verifies the response granted exactly that (no more, no less, modulo
   * the always-implicit `metadata: read`) before trusting the token. Each
   * caller requests the narrowest permission set it needs — see
   * withIssuesToken/withChecksToken for why these are minted separately
   * from withRepositoryToken rather than requesting a union of everything.
   */
  private async mintScopedToken(
    repository: string,
    permissions: Record<string, string>,
    isAllowedPermission: (name: string, level: string) => boolean,
  ): Promise<string> {
    const [owner, name] = repository.split("/");
    const appJwt = await this.appJwt();
    const installationResponse = await this.requestJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`,
      appJwt,
    );
    const installation = record(await installationResponse.json());
    const installationId = positiveInteger(installation.id);
    const tokenResponse = await this.requestJson(
      `/app/installations/${installationId}/access_tokens`,
      appJwt,
      { method: "POST", body: JSON.stringify({ repositories: [name], permissions }) },
      [201],
    );
    const payload = record(await tokenResponse.json());
    const grantedPermissions = record(payload.permissions);
    const repositories = Array.isArray(payload.repositories) ? payload.repositories.map(record) : [];
    const scopedRepository = repositories.some(
      (candidate) => typeof candidate.full_name === "string" && candidate.full_name.toLowerCase() === repository,
    );
    const expiresAt = typeof payload.expires_at === "string" ? Date.parse(payload.expires_at) : Number.NaN;
    const unexpectedPermission = Object.entries(grantedPermissions).some(
      ([permissionName, level]) => !isAllowedPermission(permissionName, level as string),
    );
    const requestedGranted = Object.entries(permissions).every(
      ([permissionName, level]) => grantedPermissions[permissionName] === level,
    );
    if (
      !isSafeGitHubInstallationToken(payload.token) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= this.now().getTime() + 60_000 ||
      !requestedGranted ||
      unexpectedPermission ||
      !scopedRepository
    ) {
      throw new Error("github_installation_token_scope_invalid");
    }
    return payload.token;
  }

  private async revokeToken(token: string): Promise<void> {
    await this.requestJson("/installation/token", token, { method: "DELETE" }, [204]);
  }

  private async findPullRequest(token: string, input: PullRequestInput): Promise<PullRequestResult | null> {
    const [owner, name] = input.repository.split("/");
    const query = new URLSearchParams({
      state: "open",
      head: `${owner}:${input.headRef}`,
      base: input.baseRef,
      per_page: "100",
    });
    const response = await this.requestJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls?${query.toString()}`,
      token,
    );
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error("github_api_invalid_response");
    const marker = `${RUN_MARKER_PREFIX}${input.runId} -->`;
    for (const item of payload) {
      const candidate = record(item);
      if (typeof candidate.body === "string" && candidate.body.includes(marker)) {
        return this.parsePullRequest(candidate, input.repository, input.acceptReadyForReview === true);
      }
    }
    return null;
  }

  private parsePullRequest(value: unknown, repository: string, acceptReadyForReview = false): PullRequestResult {
    const payload = record(value);
    const number = positiveInteger(payload.number);
    if (payload.draft !== true && !acceptReadyForReview) throw new Error("github_pull_request_not_draft");
    const expectedUrl = `https://github.com/${repository}/pull/${number}`;
    if (typeof payload.html_url !== "string") throw new Error("github_pull_request_response_invalid");
    let receivedUrl: URL;
    try {
      receivedUrl = new URL(payload.html_url);
    } catch {
      throw new Error("github_pull_request_response_invalid");
    }
    if (
      receivedUrl.protocol !== "https:" ||
      receivedUrl.hostname.toLowerCase() !== "github.com" ||
      receivedUrl.port ||
      receivedUrl.username ||
      receivedUrl.password ||
      receivedUrl.search ||
      receivedUrl.hash ||
      receivedUrl.pathname.toLowerCase() !== new URL(expectedUrl).pathname.toLowerCase()
    ) {
      throw new Error("github_pull_request_response_invalid");
    }
    return { number, url: expectedUrl };
  }

  private async findStatusComment(
    token: string,
    repository: string,
    pullRequestNumber: number,
    runId: string,
  ): Promise<{ id: number } | null> {
    const [owner, name] = repository.split("/");
    const response = await this.requestJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${pullRequestNumber}/comments?per_page=100`,
      token,
    );
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error("github_api_invalid_response");
    const marker = `${STATUS_COMMENT_MARKER_PREFIX}${runId} -->`;
    for (const item of payload) {
      const candidate = record(item);
      if (typeof candidate.body === "string" && candidate.body.includes(marker)) {
        return { id: positiveInteger(candidate.id) };
      }
    }
    return null;
  }

  private async findCheckRun(
    token: string,
    repository: string,
    headSha: string,
    runId: string,
  ): Promise<{ id: number } | null> {
    const [owner, name] = repository.split("/");
    const response = await this.requestJson(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits/${headSha}/check-runs?per_page=100`,
      token,
    );
    const payload = record(await response.json());
    const checkRuns = Array.isArray(payload.check_runs) ? payload.check_runs.map(record) : [];
    for (const candidate of checkRuns) {
      if (candidate.external_id === runId) return { id: positiveInteger(candidate.id) };
    }
    return null;
  }

  private async requestJson(
    path: string,
    bearer: string,
    init: RequestInit = {},
    expectedStatuses: number[] = [200],
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
        ...init,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${bearer}`,
          "content-type": "application/json",
          "user-agent": "wardby",
          "x-github-api-version": this.apiVersion,
          ...init.headers,
        },
      });
    } catch (error) {
      // Keep the cause: the operator log needs the transport reason (DNS,
      // TLS, connect timeout); the message itself stays fixed and safe.
      throw new Error("github_api_unavailable", { cause: error });
    }
    if (!expectedStatuses.includes(response.status)) throw safeApiError(response);
    return response;
  }
}
