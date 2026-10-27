// TEST ONLY (wardby-sim). GitHub App authentication routes, shared by the simulator and by
// the in-process fake api.github.com unit tests use (src/providers/review-host/
// github.test-support.ts), so both answer the token dance the same way:
//
//   GET    /app                                   the App (id, slug, owner), App JWT
//   GET    /repos/{owner}/{repo}/installation     the repo's installation, App JWT
//   POST   /app/installations/{id}/access_tokens  an installation token, echoing back exactly
//                                                 the requested permissions (+ metadata: read)
//   DELETE /installation/token                    revoke the calling token
//
// Pure: no I/O, no test framework. Each caller supplies its policy (JWT check, token
// minting, revocation) through GitHubAuthPolicy.
import { createPublicKey, createVerify } from "node:crypto";
import { matchPath } from "../http.js";

export interface AuthCall {
  method: string;
  /** Path without the query string. */
  path: string;
  body: unknown;
  authorization: string | null;
}

export interface AuthAnswer {
  status: number;
  body: unknown;
}

export interface GrantedToken {
  token: string;
  expires_at: string;
  permissions: Record<string, string>;
  repositories: { full_name: string }[];
}

export interface GitHubAuthPolicy {
  app: () => { id: number; slug: string; owner: { login: string } };
  /** Whether the bearer is a valid App JWT; absent = accept any bearer (the in-process fake). */
  verifyAppJwt?: (jwt: string) => boolean;
  /** The installation id for `owner/repo`, or undefined (404). */
  installationFor: (fullName: string) => number | undefined;
  /**
   * Issues a token for `installationId`, or answers 404 (no such installation) or 422 (a
   * permission the installation has not granted, GitHub's answer).
   */
  issue: (
    installationId: number,
    requested: { permissions: Record<string, string>; repositories: string[] },
  ) => GrantedToken | { status: 404 | 422; message: string };
  /** Revokes the bearer; false when it is not a live installation token (401). */
  revoke?: (token: string) => boolean;
}

function bearer(authorization: string | null): string | null {
  if (!authorization) return null;
  const match = /^(?:Bearer|token)\s+(.+)$/i.exec(authorization);
  return match ? match[1] : null;
}

const UNAUTHORIZED: AuthAnswer = {
  status: 401,
  body: {
    message: "A JSON web token could not be decoded",
    documentation_url: "https://docs.github.com/rest",
  },
};

/** Answers one of the four authentication routes, or undefined for any other call. */
export function handleGitHubAuth(call: AuthCall, policy: GitHubAuthPolicy): AuthAnswer | undefined {
  const appJwtOk = (): boolean => {
    if (!policy.verifyAppJwt) return true;
    const jwt = bearer(call.authorization);
    return jwt !== null && policy.verifyAppJwt(jwt);
  };
  if (call.method === "GET" && call.path === "/app") {
    if (!appJwtOk()) return UNAUTHORIZED;
    return { status: 200, body: policy.app() };
  }
  const installation = matchPath("/repos/{owner}/{repo}/installation", call.path);
  if (installation && call.method === "GET") {
    if (!appJwtOk()) return UNAUTHORIZED;
    const id = policy.installationFor(`${installation.owner}/${installation.repo}`);
    if (id === undefined) {
      return { status: 404, body: { message: "Not Found", documentation_url: "https://docs.github.com/rest" } };
    }
    return { status: 200, body: { id, app_id: policy.app().id, app_slug: policy.app().slug } };
  }
  const tokens = matchPath("/app/installations/{id}/access_tokens", call.path);
  if (tokens && call.method === "POST") {
    if (!appJwtOk()) return UNAUTHORIZED;
    const body = (call.body ?? {}) as { permissions?: Record<string, string>; repositories?: string[] };
    const issued = policy.issue(Number(tokens.id), {
      permissions: body.permissions ?? {},
      repositories: body.repositories ?? [],
    });
    if ("status" in issued) return { status: issued.status, body: { message: issued.message } };
    return { status: 201, body: issued };
  }
  if (call.method === "DELETE" && call.path === "/installation/token") {
    if (policy.revoke) {
      const token = bearer(call.authorization);
      if (!token || !policy.revoke(token)) return { status: 401, body: { message: "Bad credentials" } };
    }
    return { status: 204, body: null };
  }
  return undefined;
}

/**
 * Verifies an RS256 App JWT the way GitHub does: signature with the App's public key, `iss`
 * the App id, `exp` in the future and at most 10 minutes after `iat`, `iat` not in the future
 * (60 s skew allowed).
 */
export function verifyRs256AppJwt(jwt: string, publicKeyPem: string, appId: number, nowMs: number): boolean {
  const parts = jwt.split(".");
  if (parts.length !== 3) return false;
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Record<string, unknown>;
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    if (header.alg !== "RS256") return false;
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${parts[0]}.${parts[1]}`);
    if (!verifier.verify(createPublicKey(publicKeyPem), Buffer.from(parts[2], "base64url"))) return false;
    const now = Math.floor(nowMs / 1000);
    const iat = Number(claims.iat);
    const exp = Number(claims.exp);
    if (String(claims.iss) !== String(appId)) return false;
    if (!Number.isFinite(iat) || !Number.isFinite(exp)) return false;
    if (iat > now + 60 || exp <= now || exp - iat > 10 * 60 + 60) return false;
    return true;
  } catch {
    return false;
  }
}
