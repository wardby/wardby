/**
 * GitHub App user authorization (the OAuth web flow), used only to learn a
 * wardby principal's GitHub identity for link_host_account. The user token is
 * never stored, logged, or returned: `complete` exchanges the code (with the
 * PKCE verifier and the App's client secret), reads `GET /user`, and revokes
 * the token immediately, on every path. Repository permission checks use the
 * App's installation token instead (GitHubReviewHost.repositoryPermission).
 * See docs/private/2026-09-26-repo-access-authorization-spec-and-plan.md §3.
 */
import { logger } from "../../core/logger.js";
import type { GitHubAppClient } from "../vcs/github.js";
import { ReviewHostError, type HostUserAuthorizer } from "./types.js";

const log = logger.child({ module: "github-user-auth" });
const DEFAULT_WEB_BASE_URL = "https://github.com";
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** GitHub user-to-server tokens (ghu_…) are opaque; accept a bounded, header-safe shape only. */
const SAFE_TOKEN = /^[A-Za-z0-9_.-]{20,512}$/;
const SAFE_ERROR_CODE = /^[a-z_]{1,64}$/;

type Fetch = typeof globalThis.fetch;

export interface GitHubUserAuthorizerOptions {
  /** The App's API client; `GET /user` and the revocation go through its requestJson. */
  client: Pick<GitHubAppClient, "requestJson">;
  /** The App's OAuth Client ID (not the numeric App ID). */
  clientId: string;
  clientSecret: string;
  /** Tests only: the web host that serves /login/oauth/*. */
  webBaseUrl?: string;
  /** Tests only: the fetch used for the web host. */
  fetch?: Fetch;
}

export class GitHubUserAuthorizer implements HostUserAuthorizer {
  readonly provider = "github" as const;
  private readonly webBaseUrl: string;
  private readonly fetchImpl: Fetch;

  constructor(private readonly options: GitHubUserAuthorizerOptions) {
    const web = new URL(options.webBaseUrl ?? DEFAULT_WEB_BASE_URL);
    if (web.protocol !== "https:" || web.pathname !== "/" || web.search || web.username || web.password) {
      throw new Error("github_web_base_url_invalid");
    }
    this.webBaseUrl = web.origin;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  authorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string {
    const url = new URL("/login/oauth/authorize", this.webBaseUrl);
    url.search = new URLSearchParams({
      client_id: this.options.clientId,
      redirect_uri: input.redirectUri,
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: "S256",
      // The link is for an existing GitHub account, never a new one.
      allow_signup: "false",
      // Lets someone signed in to several accounts pick the right one.
      prompt: "select_account",
    }).toString();
    return url.toString();
  }

  async complete(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<{
    hostUserId: string;
    login: string;
  }> {
    const token = await this.exchange(input);
    try {
      const response = await this.options.client.requestJson("/user", token);
      const user = (await response.json()) as Record<string, unknown> | null;
      const id = user?.id;
      const login = user?.login;
      if (
        user?.type !== "User" ||
        !Number.isSafeInteger(id) ||
        (id as number) <= 0 ||
        typeof login !== "string" ||
        !GITHUB_LOGIN.test(login)
      ) {
        throw new ReviewHostError("host_invalid_response", "github_user_invalid");
      }
      return { hostUserId: String(id), login };
    } catch (err) {
      if (err instanceof ReviewHostError) throw err;
      const message = err instanceof Error && /^github_[a-z_]+(:\d{3})?/.test(err.message) ? err.message : "";
      throw new ReviewHostError("host_api_error", message.split(":").slice(0, 2).join(":") || "github_user_failed");
    } finally {
      await this.revoke(token);
    }
  }

  private async exchange(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.webBaseUrl}/login/oauth/access_token`, {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json", "user-agent": "wardby" },
        body: JSON.stringify({
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
          code: input.code,
          code_verifier: input.codeVerifier,
          redirect_uri: input.redirectUri,
        }),
      });
    } catch {
      throw new ReviewHostError("host_api_error", "github_oauth_unavailable");
    }
    if (response.status !== 200) {
      throw new ReviewHostError("host_api_error", `github_oauth_exchange_failed:${response.status}`);
    }
    let payload: Record<string, unknown> | null = null;
    try {
      payload = (await response.json()) as Record<string, unknown> | null;
    } catch {
      // handled below
    }
    // GitHub reports a refused exchange (bad or expired code, wrong verifier) as a 200 with `error`.
    if (payload && typeof payload.error === "string") {
      const code = SAFE_ERROR_CODE.test(payload.error) ? payload.error : "unknown";
      throw new ReviewHostError("host_api_error", `github_oauth_exchange_failed:${code}`);
    }
    const token = payload?.access_token;
    if (typeof token !== "string" || !SAFE_TOKEN.test(token)) {
      throw new ReviewHostError("host_invalid_response", "github_oauth_token_invalid");
    }
    return token;
  }

  /** DELETE /applications/{client_id}/token (Basic auth with the client credentials). Never throws. */
  private async revoke(token: string): Promise<void> {
    const basic = Buffer.from(`${this.options.clientId}:${this.options.clientSecret}`).toString("base64");
    try {
      await this.options.client.requestJson(
        `/applications/${encodeURIComponent(this.options.clientId)}/token`,
        // requestJson always sets a bearer; the explicit header below replaces it.
        "revocation",
        {
          method: "DELETE",
          headers: { authorization: `Basic ${basic}` },
          body: JSON.stringify({ access_token: token }),
        },
        [204],
      );
    } catch (err) {
      log.warn(
        { reason: err instanceof Error ? err.message.split(":").slice(0, 2).join(":") : "unknown" },
        "could not revoke a GitHub user token; it expires on its own",
      );
    }
  }
}
