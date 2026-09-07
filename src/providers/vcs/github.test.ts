import { generateKeyPairSync } from "node:crypto";
import { decodeJwt } from "jose";
import { describe, expect, it, vi } from "vitest";
import { GitHubAppClient } from "./github.js";

const TOKEN = "ghs_abcdefghijklmnopqrstuvwxyz1234567890";
const NOW = new Date("2026-09-06T12:00:00.000Z");

function privateKeyPem(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs1",
    format: "pem",
  }).toString();
}

function json(value: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return json({
    token: TOKEN,
    expires_at: "2026-09-06T13:00:00Z",
    permissions: { contents: "write", pull_requests: "write" },
    repositories: [{ full_name: "openai/example" }],
    ...overrides,
  }, 201);
}

describe("GitHubAppClient", () => {
  it("mints and revokes a repository-scoped minimum-permission installation token", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/repos/openai/example/installation")) return json({ id: 42 });
      if (url.endsWith("/app/installations/42/access_tokens")) return tokenResponse();
      if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;
    const client = new GitHubAppClient(
      { appId: "123", privateKey: privateKeyPem() },
      fetchMock,
      () => NOW,
    );

    await expect(client.withRepositoryToken("OpenAI/Example.git", async (token) => {
      expect(token).toBe(TOKEN);
      return "ok";
    })).resolves.toBe("ok");

    const installationAuth = new Headers(calls[0].init?.headers).get("authorization")!;
    const jwt = installationAuth.replace(/^Bearer /, "");
    expect(decodeJwt(jwt)).toMatchObject({ iss: "123", iat: 1788695940, exp: 1788696540 });
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      repositories: ["example"],
      permissions: { contents: "write", pull_requests: "write" },
    });
    expect(new Headers(calls[1].init?.headers).get("x-github-api-version")).toBe("2026-03-10");
    expect(new Headers(calls[2].init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(calls[2].init?.method).toBe("DELETE");
  });

  it("fails closed when GitHub does not confirm exact repository and permission scope", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/installation")) return json({ id: 42 });
      return tokenResponse({
        permissions: { contents: "read", pull_requests: "write" },
        repositories: [{ full_name: "openai/other" }],
      });
    }) as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);
    await expect(client.withRepositoryToken("openai/example", async () => undefined))
      .rejects.toThrow("github_installation_token_scope_invalid");
  });

  it("returns an existing marked pull request without creating a duplicate", async () => {
    const methods: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      methods.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      if (url.endsWith("/installation")) return json({ id: 42 });
      if (url.endsWith("/access_tokens")) return tokenResponse();
      if (url.includes("/pulls?")) {
        expect(new URL(url).searchParams.get("head")).toBe("openai:reevo/run-run-1");
        return json([{
          number: 7,
          html_url: "https://github.com/openai/example/pull/7",
          body: "<!-- reevo-run:run-1 -->",
          draft: true,
        }]);
      }
      if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);

    await expect(client.createOrFindDraftPullRequest({
      runId: "run-1",
      repository: "openai/example",
      baseRef: "main",
      headRef: "reevo/run-run-1",
    })).resolves.toEqual({ number: 7, url: "https://github.com/openai/example/pull/7" });
    expect(methods.filter((method) => method === "POST /repos/openai/example/pulls")).toHaveLength(0);
  });

  it("creates only a draft PR with fixed metadata and recovers a duplicate-create race", async () => {
    let lookups = 0;
    let createBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/installation")) return json({ id: 42 });
      if (url.endsWith("/access_tokens")) return tokenResponse();
      if (url.includes("/pulls?") && (init?.method ?? "GET") === "GET") {
        lookups += 1;
        return lookups === 1 ? json([]) : json([{
          number: 8,
          html_url: "https://github.com/openai/example/pull/8",
          body: "<!-- reevo-run:run-1 -->",
          draft: true,
        }]);
      }
      if (url.endsWith("/pulls") && init?.method === "POST") {
        createBody = JSON.parse(String(init.body));
        return json({ message: `duplicate ${TOKEN}` }, 422);
      }
      if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);

    await expect(client.createOrFindDraftPullRequest({
      runId: "run-1",
      repository: "openai/example",
      baseRef: "main",
      headRef: "reevo/run-run-1",
    })).resolves.toEqual({ number: 8, url: "https://github.com/openai/example/pull/8" });
    expect(createBody).toEqual({
      title: "Reevo run run-1",
      head: "reevo/run-run-1",
      base: "main",
      body: "<!-- reevo-run:run-1 -->",
      draft: true,
    });
  });

  it("normalizes the URL returned by a successful draft PR creation", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/installation")) return json({ id: 42 });
      if (url.endsWith("/access_tokens")) return tokenResponse();
      if (url.includes("/pulls?")) return json([]);
      if (url.endsWith("/pulls") && init?.method === "POST") return json({
        number: 9,
        html_url: "https://github.com/OpenAI/Example/pull/9",
        draft: true,
      }, 201);
      if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);

    await expect(client.createOrFindDraftPullRequest({
      runId: "run-1",
      repository: "openai/example",
      baseRef: "main",
      headRef: "reevo/run-run-1",
    })).resolves.toEqual({ number: 9, url: "https://github.com/openai/example/pull/9" });
  });

  it("returns bounded API categories rather than credential-bearing response bodies", async () => {
    const fetchMock = vi.fn(async () => json(
      { message: `server exposed ${TOKEN}` },
      500,
      { "x-github-request-id": "safe-request-id" },
    )) as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);

    const error = await client.withRepositoryToken("openai/example", async () => undefined).catch((caught) => caught);
    expect(error).toEqual(new Error("github_api_error:500:safe-request-id"));
    expect(String(error)).not.toContain(TOKEN);
  });

  it("rejects a marked PR that is not a draft", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/installation")) return json({ id: 42 });
      if (url.endsWith("/access_tokens")) return tokenResponse();
      if (url.includes("/pulls?")) return json([{
        number: 7,
        html_url: "https://github.com/OpenAI/Example/pull/7",
        body: "<!-- reevo-run:run-1 -->",
        draft: false,
      }]);
      if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);
    await expect(client.createOrFindDraftPullRequest({
      runId: "run-1",
      repository: "openai/example",
      baseRef: "main",
      headRef: "reevo/run-run-1",
    })).rejects.toThrow("github_pull_request_not_draft");
  });

  it("rejects non-HTTPS or credentialed API base URLs", () => {
    expect(() => new GitHubAppClient({
      appId: "123",
      privateKey: privateKeyPem(),
      apiBaseUrl: "http://api.github.com",
    })).toThrow("github_api_base_url_invalid");
    expect(() => new GitHubAppClient({
      appId: "123",
      privateKey: privateKeyPem(),
      apiBaseUrl: "https://token@api.github.com",
    })).toThrow("github_api_base_url_invalid");
    expect(() => new GitHubAppClient({
      appId: "123",
      privateKey: privateKeyPem(),
      apiVersion: "latest\r\nx-injected: true",
    })).toThrow("github_api_version_invalid");
  });
});
