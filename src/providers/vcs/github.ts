import { createPrivateKey } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { normalizeGitHubRepository, normalizeGitRef } from "../../coding/protocol.js";

const DEFAULT_API_BASE_URL = "https://api.github.com";
const DEFAULT_API_VERSION = "2026-03-10";
const RUN_MARKER_PREFIX = "<!-- reevo-run:";

export interface GitHubAppConfig {
  appId: string;
  privateKey: string;
  apiBaseUrl?: string;
  apiVersion?: string;
}

export interface PullRequestInput {
  runId: string;
  repository: string;
  baseRef: string;
  headRef: string;
}

export interface PullRequestResult {
  number: number;
  url: string;
}

export interface GitHubRepositoryAccess {
  withRepositoryToken<T>(repository: string, action: (token: string) => Promise<T>): Promise<T>;
  createOrFindDraftPullRequest(input: PullRequestInput): Promise<PullRequestResult>;
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

  async createOrFindDraftPullRequest(input: PullRequestInput): Promise<PullRequestResult> {
    const repository = normalizeGitHubRepository(input.repository);
    const baseRef = normalizeGitRef(input.baseRef);
    const headRef = normalizeGitRef(input.headRef);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input.runId) || headRef !== `reevo/run-${input.runId}`) {
      throw new Error("github_pull_request_input_invalid");
    }

    return this.withRepositoryToken(repository, async (token) => {
      const existing = await this.findPullRequest(token, { ...input, repository, baseRef, headRef });
      if (existing) return existing;

      const [owner, name] = repository.split("/");
      const marker = `${RUN_MARKER_PREFIX}${input.runId} -->`;
      const response = await this.requestJson(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pulls`,
        token,
        {
          method: "POST",
          body: JSON.stringify({
            title: `Reevo run ${input.runId}`,
            head: headRef,
            base: baseRef,
            body: marker,
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
      {
        method: "POST",
        body: JSON.stringify({
          repositories: [name],
          permissions: { contents: "write", pull_requests: "write" },
        }),
      },
      [201],
    );
    const payload = record(await tokenResponse.json());
    const permissions = record(payload.permissions);
    const repositories = Array.isArray(payload.repositories) ? payload.repositories.map(record) : [];
    const scopedRepository = repositories.some(
      (candidate) => typeof candidate.full_name === "string" && candidate.full_name.toLowerCase() === repository,
    );
    const expiresAt = typeof payload.expires_at === "string" ? Date.parse(payload.expires_at) : Number.NaN;
    const unexpectedPermission = Object.entries(permissions).some(
      ([name, level]) =>
        !(
          (name === "contents" && level === "write") ||
          (name === "pull_requests" && level === "write") ||
          (name === "metadata" && level === "read")
        ),
    );
    if (
      typeof payload.token !== "string" ||
      payload.token.length < 20 ||
      Buffer.byteLength(payload.token, "utf8") > 512 ||
      !/^[A-Za-z0-9_]+$/.test(payload.token) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= this.now().getTime() + 60_000 ||
      permissions.contents !== "write" ||
      permissions.pull_requests !== "write" ||
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
        if (candidate.draft !== true) throw new Error("github_pull_request_not_draft");
        return this.parsePullRequest(candidate, input.repository);
      }
    }
    return null;
  }

  private parsePullRequest(value: unknown, repository: string): PullRequestResult {
    const payload = record(value);
    const number = positiveInteger(payload.number);
    if (payload.draft !== true) throw new Error("github_pull_request_not_draft");
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
          "user-agent": "reevo-run",
          "x-github-api-version": this.apiVersion,
          ...init.headers,
        },
      });
    } catch {
      throw new Error("github_api_unavailable");
    }
    if (!expectedStatuses.includes(response.status)) throw safeApiError(response);
    return response;
  }
}
