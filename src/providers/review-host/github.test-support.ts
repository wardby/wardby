// src/providers/review-host/github.test-support.ts
import { generateKeyPairSync } from "node:crypto";
import { vi } from "vitest";
import { GitHubAppClient } from "../vcs/github.js";

export const NOW = new Date("2026-09-26T12:00:00.000Z");
export const TOKEN = "ghs_abcdefghijklmnopqrstuvwxyz-1234567890.example";
export const SHA = "0123456789abcdef0123456789abcdef01234567";
export const OLD_SHA = "89abcdef0123456789abcdef0123456789abcdef";
/** The App id the fake answers `GET /app` with; real summary comments carry it. */
export const APP_ID = 777;
export const BY_APP = { performed_via_github_app: { id: APP_ID } };

export interface Call {
  method: string;
  path: string;
  body: unknown;
  accept: string | null;
  authorization: string | null;
}

export type Handler = (call: Call) => Response | undefined;

export function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

/**
 * A fake api.github.com: answers the token dance (echoing back exactly the
 * requested permissions) and `GET /app` (as APP_ID), then routes every other
 * call to `handler`.
 */
export function fakeGitHub(handler: Handler): { client: GitHubAppClient; calls: Call[]; grants: unknown[] } {
  const calls: Call[] = [];
  const grants: unknown[] = [];
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = `${url.pathname}${url.search}`;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const accept = new Headers(init?.headers).get("accept");
    const authorization = new Headers(init?.headers).get("authorization");
    if (path === "/app" && method === "GET") return json({ id: APP_ID, slug: "wardby" });
    if (path.endsWith("/installation") && method === "GET") return json({ id: 42 });
    if (path === "/app/installations/42/access_tokens") {
      const requested = (body as { permissions: Record<string, string>; repositories: string[] }).permissions;
      grants.push(requested);
      return json(
        {
          token: TOKEN,
          expires_at: "2026-09-26T13:00:00Z",
          permissions: { ...requested, metadata: "read" },
          repositories: [{ full_name: "chfields/knock-knock-jokes" }],
        },
        201,
      );
    }
    if (path === "/installation/token" && method === "DELETE") return new Response(null, { status: 204 });
    const call = { method, path, body, accept, authorization };
    calls.push(call);
    const response = handler(call);
    if (!response) throw new Error(`unexpected ${method} ${path}`);
    return response;
  }) as unknown as typeof fetch;
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" })
    .toString();
  return { client: new GitHubAppClient({ appId: "123", privateKey }, fetchMock, () => NOW), calls, grants };
}

export const REPO = "chfields/knock-knock-jokes";
export const PR = {
  number: 7,
  title: "Add joke",
  body: "Adds a joke",
  user: { login: "wardby[bot]" },
  state: "open",
  merged: false,
  draft: true,
  base: { ref: "main", repo: { full_name: "chfields/knock-knock-jokes" } },
  head: { ref: "feature", sha: SHA, repo: { full_name: "chfields/knock-knock-jokes" } },
  html_url: "https://github.com/chfields/knock-knock-jokes/pull/7",
};
export const PATCH = "@@ -1,2 +1,3 @@\n line one\n+new two\n line three";
