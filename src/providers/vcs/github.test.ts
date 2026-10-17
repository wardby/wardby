import { generateKeyPairSync } from "node:crypto";
import { decodeJwt } from "jose";
import { describe, expect, it, vi } from "vitest";
import { ISSUE_KEY } from "../issue-tracker/types.js";
import {
  DEPENDENCY_INSTALL_INCOMPLETE,
  GitHubAppClient,
  MAX_PULL_REQUEST_BODY_CHARS,
  PR_ISSUE_KEY,
  RELATED_SECTION_END,
  RELATED_SECTION_START,
  pullRequestBody,
  pullRequestTitle,
  renderRelatedSection,
  upsertRelatedSection,
  type PullRequestInput,
} from "./github.js";
import {
  DESCRIPTION_COMMENT_MARKER,
  descriptionAppliedComment,
  descriptionFallbackComment,
  descriptionSha256,
  hasClosingKeyword,
  supersededDescriptionComment,
} from "./pr-description.js";

const TOKEN = "ghs_abcdefghijklmnopqrstuvwxyz-1234567890.example";
const NOW = new Date("2026-09-06T12:00:00.000Z");

function privateKeyPem(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({
      type: "pkcs1",
      format: "pem",
    })
    .toString();
}

function json(value: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** github.ts always sends a JSON.stringify()'d string body -- narrows RequestInit's broad BodyInit type down for these test assertions. */
function bodyText(body: RequestInit["body"]): string {
  return typeof body === "string" ? body : "";
}

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return json(
    {
      token: TOKEN,
      expires_at: "2026-09-06T13:00:00Z",
      permissions: { contents: "write", pull_requests: "write" },
      repositories: [{ full_name: "openai/example" }],
      ...overrides,
    },
    201,
  );
}

describe("GitHubAppClient", () => {
  it("mints and revokes a repository-scoped minimum-permission installation token", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/repos/openai/example/installation")) return json({ id: 42 });
      if (url.endsWith("/app/installations/42/access_tokens")) return tokenResponse();
      if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);

    await expect(
      client.withRepositoryToken("OpenAI/Example.git", async (token) => {
        expect(token).toBe(TOKEN);
        return "ok";
      }),
    ).resolves.toBe("ok");

    const installationAuth = new Headers(calls[0].init?.headers).get("authorization")!;
    const jwt = installationAuth.replace(/^Bearer /, "");
    expect(decodeJwt(jwt)).toMatchObject({ iss: "123", iat: 1788695940, exp: 1788696540 });
    expect(JSON.parse(bodyText(calls[1].init?.body))).toEqual({
      repositories: ["example"],
      permissions: { contents: "write", pull_requests: "write" },
    });
    expect(new Headers(calls[1].init?.headers).get("x-github-api-version")).toBe("2026-03-10");
    expect(new Headers(calls[2].init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(calls[2].init?.method).toBe("DELETE");
  });

  it("fails closed when GitHub does not confirm exact repository and permission scope", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (String(input).endsWith("/installation")) return json({ id: 42 });
      return tokenResponse({
        permissions: { contents: "read", pull_requests: "write" },
        repositories: [{ full_name: "openai/other" }],
      });
    }) as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);
    await expect(client.withRepositoryToken("openai/example", async () => undefined)).rejects.toThrow(
      "github_installation_token_scope_invalid",
    );
  });

  it("returns an existing marked pull request without creating a duplicate", async () => {
    const methods: string[] = [];
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      methods.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      if (url.endsWith("/installation")) return json({ id: 42 });
      if (url.endsWith("/access_tokens")) return tokenResponse();
      if (url.includes("/pulls?")) {
        expect(new URL(url).searchParams.get("head")).toBe("openai:wardby/run-run-1");
        return json([
          {
            number: 7,
            html_url: "https://github.com/openai/example/pull/7",
            body: "<!-- wardby:run-1 -->",
            draft: true,
          },
        ]);
      }
      if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);

    await expect(
      client.createOrFindDraftPullRequest({
        runId: "run-1",
        repository: "openai/example",
        baseRef: "main",
        headRef: "wardby/run-run-1",
      }),
    ).resolves.toEqual({ number: 7, url: "https://github.com/openai/example/pull/7" });
    expect(methods.filter((method) => method === "POST /repos/openai/example/pulls")).toHaveLength(0);
  });

  it("findOpenPullRequest finds the root run's open marked PR, and returns null once it is merged or closed", async () => {
    let lookups = 0;
    const methods: string[] = [];
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      methods.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      if (url.endsWith("/installation")) return json({ id: 42 });
      if (url.endsWith("/access_tokens")) return tokenResponse();
      if (url.includes("/pulls?")) {
        lookups += 1;
        // GitHub's `state=open` list no longer contains a merged/closed PR: answer [] the second time.
        return lookups === 1
          ? json([
              {
                number: 42,
                html_url: "https://github.com/openai/example/pull/42",
                body: "<!-- wardby:run-1 -->",
                draft: true,
              },
            ])
          : json([]);
      }
      if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);

    await expect(
      client.findOpenPullRequest({
        runId: "run-1",
        repository: "openai/example",
        baseRef: "main",
        headRef: "wardby/run-run-1",
      }),
    ).resolves.toEqual({ number: 42, url: "https://github.com/openai/example/pull/42" });
    await expect(
      client.findOpenPullRequest({
        runId: "run-1",
        repository: "openai/example",
        baseRef: "main",
        headRef: "wardby/run-run-1",
      }),
    ).resolves.toBeNull();
    expect(methods.filter((method) => method === "POST /repos/openai/example/pulls")).toHaveLength(0);
  });

  it("openPullRequestDraft reads GitHub's draft flag on the root run's open marked PR", async () => {
    const answers: unknown[][] = [
      [
        {
          number: 42,
          html_url: "https://github.com/openai/example/pull/42",
          body: "<!-- wardby:run-1 -->",
          draft: true,
        },
      ],
      [
        {
          number: 42,
          html_url: "https://github.com/openai/example/pull/42",
          body: "<!-- wardby:run-1 -->",
          draft: false,
        },
      ],
      [],
    ];
    const fetchMock = vi.fn(async (input: string) => {
      const url = String(input);
      if (url.endsWith("/installation")) return json({ id: 42 });
      if (url.endsWith("/access_tokens")) return tokenResponse();
      if (url.includes("/pulls?")) return json(answers.shift());
      if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);
    const input = { runId: "run-1", repository: "openai/example", baseRef: "main", headRef: "wardby/run-run-1" };

    await expect(client.openPullRequestDraft(input)).resolves.toBe(true);
    await expect(client.openPullRequestDraft(input)).resolves.toBe(false);
    await expect(client.openPullRequestDraft(input)).resolves.toBeNull();
  });

  it("creates only a draft PR with fixed metadata and recovers a duplicate-create race", async () => {
    let lookups = 0;
    let createBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/installation")) return json({ id: 42 });
      if (url.endsWith("/access_tokens")) return tokenResponse();
      if (url.includes("/pulls?") && (init?.method ?? "GET") === "GET") {
        lookups += 1;
        return lookups === 1
          ? json([])
          : json([
              {
                number: 8,
                html_url: "https://github.com/openai/example/pull/8",
                body: "<!-- wardby:run-1 -->",
                draft: true,
              },
            ]);
      }
      if (url.endsWith("/pulls") && init?.method === "POST") {
        createBody = JSON.parse(bodyText(init.body));
        return json({ message: `duplicate ${TOKEN}` }, 422);
      }
      if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);

    await expect(
      client.createOrFindDraftPullRequest({
        runId: "run-1",
        repository: "openai/example",
        baseRef: "main",
        headRef: "wardby/run-run-1",
      }),
    ).resolves.toEqual({ number: 8, url: "https://github.com/openai/example/pull/8" });
    expect(createBody).toEqual({
      title: "Wardby run run-1",
      head: "wardby/run-run-1",
      base: "main",
      body: "<!-- wardby:run-1 -->",
      draft: true,
    });
  });

  it("puts the agent's summary and test results in the PR body, keeping the tracking marker first", async () => {
    let createBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/installation")) return json({ id: 42 });
      if (url.endsWith("/access_tokens")) return tokenResponse();
      if (url.includes("/pulls?")) return json([]);
      if (url.endsWith("/pulls") && init?.method === "POST") {
        createBody = JSON.parse(bodyText(init.body));
        return json({ number: 10, html_url: "https://github.com/openai/example/pull/10", draft: true }, 201);
      }
      if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);

    await client.createOrFindDraftPullRequest({
      runId: "run-1",
      repository: "openai/example",
      baseRef: "main",
      headRef: "wardby/run-run-1",
      summary: "Added a hello.py script and confirmed it runs.",
      tests: [
        { command: "python3 hello.py", outcome: "passed" },
        { command: "pytest -q", outcome: "failed" },
      ],
    });

    expect(createBody?.title).toBe("Wardby run run-1");
    const body = createBody?.body as string;
    expect(body.startsWith("<!-- wardby:run-1 -->\n")).toBe(true);
    expect(body).toContain("Added a hello.py script and confirmed it runs.");
    expect(body).toContain("`python3 hello.py`: passed");
    expect(body).toContain("`pytest -q`: failed");
  });

  it("adds a collapsed packages section with refusals to the pull request body, deduplicated", async () => {
    let createBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/installation")) return json({ id: 42 });
      if (url.endsWith("/access_tokens")) return tokenResponse();
      if (url.includes("/pulls?")) return json([]);
      if (url.endsWith("/pulls") && init?.method === "POST") {
        createBody = JSON.parse(bodyText(init.body));
        return json({ number: 12, html_url: "https://github.com/openai/example/pull/12", draft: true }, 201);
      }
      if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);

    await client.createOrFindDraftPullRequest({
      runId: "run-1",
      repository: "openai/example",
      baseRef: "main",
      headRef: "wardby/run-run-1",
      summary: "Added HeroUI.",
      packages: [
        { ecosystem: "npm", name: "@heroui/react", version: "3.2.6" },
        { ecosystem: "npm", name: "@heroui/react", version: "3.2.6" },
      ],
      packageRefusals: [{ ecosystem: "npm", name: "left-pad", reason: "wardby_package_not_allowed" }],
    });

    const body = createBody?.body as string;
    expect(body).toContain("<details>\n<summary>Packages installed during this run (1)</summary>");
    expect(body).toContain("- npm `@heroui/react@3.2.6`");
    expect(body).toContain("- npm `left-pad`: wardby_package_not_allowed");
  });

  it("drops (never renders) a package or refusal entry whose field contains a backtick or newline", async () => {
    let createBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/installation")) return json({ id: 42 });
      if (url.endsWith("/access_tokens")) return tokenResponse();
      if (url.includes("/pulls?")) return json([]);
      if (url.endsWith("/pulls") && init?.method === "POST") {
        createBody = JSON.parse(bodyText(init.body));
        return json({ number: 13, html_url: "https://github.com/openai/example/pull/13", draft: true }, 201);
      }
      if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);

    await client.createOrFindDraftPullRequest({
      runId: "run-1",
      repository: "openai/example",
      baseRef: "main",
      headRef: "wardby/run-run-1",
      packages: [
        { ecosystem: "npm", name: "evil`)</details><script>alert(1)</script", version: "1.0.0" },
        { ecosystem: "npm", name: "evil\nname", version: "1.0.0" },
        { ecosystem: "npm", name: "safe-package", version: "1.0.0" },
      ],
      packageRefusals: [{ ecosystem: "npm", name: "left-pad", reason: "blocked`\nrow" }],
    });

    const body = createBody?.body as string;
    expect(body).toContain("<summary>Packages installed during this run (1)</summary>");
    expect(body).toContain("- npm `safe-package@1.0.0`");
    expect(body).not.toContain("evil");
    expect(body).not.toContain("**Refused:**");
  });

  it("prefixes the PR title with a caller-provided tag, leaving it unchanged when absent", async () => {
    let createBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/installation")) return json({ id: 42 });
      if (url.endsWith("/access_tokens")) return tokenResponse();
      if (url.includes("/pulls?")) return json([]);
      if (url.endsWith("/pulls") && init?.method === "POST") {
        createBody = JSON.parse(bodyText(init.body));
        return json({ number: 11, html_url: "https://github.com/openai/example/pull/11", draft: true }, 201);
      }
      if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);

    await client.createOrFindDraftPullRequest({
      runId: "run-1",
      repository: "openai/example",
      baseRef: "main",
      headRef: "wardby/run-run-1",
      tag: "JIRA-123",
    });
    expect(createBody?.title).toBe("[JIRA-123] Wardby run run-1");
  });

  it("normalizes the URL returned by a successful draft PR creation", async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/installation")) return json({ id: 42 });
      if (url.endsWith("/access_tokens")) return tokenResponse();
      if (url.includes("/pulls?")) return json([]);
      if (url.endsWith("/pulls") && init?.method === "POST")
        return json(
          {
            number: 9,
            html_url: "https://github.com/OpenAI/Example/pull/9",
            draft: true,
          },
          201,
        );
      if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);

    await expect(
      client.createOrFindDraftPullRequest({
        runId: "run-1",
        repository: "openai/example",
        baseRef: "main",
        headRef: "wardby/run-run-1",
      }),
    ).resolves.toEqual({ number: 9, url: "https://github.com/openai/example/pull/9" });
  });

  it("returns bounded API categories rather than credential-bearing response bodies", async () => {
    const fetchMock = vi.fn(async () =>
      json({ message: `server exposed ${TOKEN}` }, 500, { "x-github-request-id": "safe-request-id" }),
    ) as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);

    const error = await client.withRepositoryToken("openai/example", async () => undefined).catch((caught) => caught);
    expect(error).toEqual(new Error("github_api_error:500:safe-request-id"));
    expect(String(error)).not.toContain(TOKEN);
  });

  it("rejects a marked PR that is not a draft", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      const url = String(input);
      if (url.endsWith("/installation")) return json({ id: 42 });
      if (url.endsWith("/access_tokens")) return tokenResponse();
      if (url.includes("/pulls?"))
        return json([
          {
            number: 7,
            html_url: "https://github.com/OpenAI/Example/pull/7",
            body: "<!-- wardby:run-1 -->",
            draft: false,
          },
        ]);
      if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);
    await expect(
      client.createOrFindDraftPullRequest({
        runId: "run-1",
        repository: "openai/example",
        baseRef: "main",
        headRef: "wardby/run-run-1",
      }),
    ).rejects.toThrow("github_pull_request_not_draft");
  });

  it("accepts a marked PR a person already marked ready for review when the caller is a continuation", async () => {
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      requests.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/installation")) return json({ id: 42 });
      if (url.endsWith("/access_tokens")) return tokenResponse();
      if (url.includes("/pulls?"))
        return json([
          {
            number: 7,
            html_url: "https://github.com/OpenAI/Example/pull/7",
            body: "<!-- wardby:run-1 -->",
            draft: false,
          },
        ]);
      if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);
    await expect(
      client.createOrFindDraftPullRequest({
        runId: "run-1",
        repository: "openai/example",
        baseRef: "main",
        headRef: "wardby/run-run-1",
        acceptReadyForReview: true,
      }),
    ).resolves.toEqual({ number: 7, url: "https://github.com/openai/example/pull/7" });
    // Found, not re-created: no POST to /pulls.
    expect(requests.some((r) => r.startsWith("POST") && r.endsWith("/pulls"))).toBe(false);
  });

  describe("continuation status notifications", () => {
    const PR_LOOKUP_RESPONSE = [
      {
        number: 23,
        html_url: "https://github.com/openai/example/pull/23",
        body: "<!-- wardby:run-1 -->",
        draft: true,
      },
    ];

    it("upsertContinuationStatusComment posts a new comment (with the hidden marker first) when none exists yet", async () => {
      let createdBody: string | undefined;
      const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/installation")) return json({ id: 42 });
        if (url.endsWith("/access_tokens")) return tokenResponse();
        if (url.includes("/pulls?")) return json(PR_LOOKUP_RESPONSE);
        if (url.includes("/issues/23/comments") && method === "GET") return json([]);
        if (url.includes("/issues/23/comments") && method === "POST") {
          createdBody = JSON.parse(bodyText(init?.body)).body;
          return json({ id: 555 }, 201);
        }
        if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
        throw new Error(`unexpected request ${method} ${url}`);
      }) as typeof fetch;
      const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);

      await client.upsertContinuationStatusComment({
        runId: "run-2",
        rootRunId: "run-1",
        repository: "openai/example",
        baseRef: "main",
        headRef: "wardby/run-run-1",
        body: "working...",
      });

      expect(createdBody).toBe("<!-- wardby-status:run-2 -->\n\nworking...");
    });

    it("upsertContinuationStatusComment still finds the PR after a person marked it ready for review", async () => {
      let createdBody: string | undefined;
      const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/installation")) return json({ id: 42 });
        if (url.endsWith("/access_tokens")) return tokenResponse();
        if (url.includes("/pulls?")) return json([{ ...PR_LOOKUP_RESPONSE[0], draft: false }]);
        if (url.includes("/issues/23/comments") && method === "GET") return json([]);
        if (url.includes("/issues/23/comments") && method === "POST") {
          createdBody = JSON.parse(bodyText(init?.body)).body;
          return json({ id: 555 }, 201);
        }
        if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
        throw new Error(`unexpected request ${method} ${url}`);
      }) as typeof fetch;
      const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);

      await client.upsertContinuationStatusComment({
        runId: "run-2",
        rootRunId: "run-1",
        repository: "openai/example",
        baseRef: "main",
        headRef: "wardby/run-run-1",
        body: "working...",
      });

      expect(createdBody).toBe("<!-- wardby-status:run-2 -->\n\nworking...");
    });

    it("upsertContinuationStatusComment PATCHes the existing marked comment instead of creating a duplicate", async () => {
      let patchedBody: string | undefined;
      let postCalls = 0;
      const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/installation")) return json({ id: 42 });
        if (url.endsWith("/access_tokens")) return tokenResponse();
        if (url.includes("/pulls?")) return json(PR_LOOKUP_RESPONSE);
        if (url.includes("/issues/23/comments") && method === "GET") {
          return json([{ id: 555, body: "<!-- wardby-status:run-2 -->\n\nold" }]);
        }
        if (url.includes("/issues/23/comments") && method === "POST") {
          postCalls += 1;
          return json({ id: 999 }, 201);
        }
        if (url.endsWith("/issues/comments/555") && method === "PATCH") {
          patchedBody = JSON.parse(bodyText(init?.body)).body;
          return json({ id: 555 }, 200);
        }
        if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
        throw new Error(`unexpected request ${method} ${url}`);
      }) as typeof fetch;
      const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);

      await client.upsertContinuationStatusComment({
        runId: "run-2",
        rootRunId: "run-1",
        repository: "openai/example",
        baseRef: "main",
        headRef: "wardby/run-run-1",
        body: "still working...",
      });

      expect(patchedBody).toBe("<!-- wardby-status:run-2 -->\n\nstill working...");
      expect(postCalls).toBe(0);
    });

    it("updateContinuationStatusComment no-ops (never creates) when no marked comment exists yet", async () => {
      let writeCalls = 0;
      const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/installation")) return json({ id: 42 });
        if (url.endsWith("/access_tokens")) return tokenResponse();
        if (url.includes("/pulls?")) return json(PR_LOOKUP_RESPONSE);
        if (url.includes("/issues/23/comments") && method === "GET") return json([]);
        if (method === "POST" || method === "PATCH") {
          writeCalls += 1;
          return json({}, 200);
        }
        if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
        throw new Error(`unexpected request ${method} ${url}`);
      }) as typeof fetch;
      const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);

      await client.updateContinuationStatusComment({
        runId: "run-2",
        rootRunId: "run-1",
        repository: "openai/example",
        baseRef: "main",
        headRef: "wardby/run-run-1",
        body: "done",
      });

      expect(writeCalls).toBe(0);
    });

    it("createContinuationCheckRun creates an in-progress check run keyed by external_id, or no-ops if one already exists", async () => {
      let createCalls = 0;
      let createdBody: Record<string, unknown> | undefined;
      const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/installation")) return json({ id: 42 });
        if (url.endsWith("/access_tokens")) return tokenResponse({ permissions: { checks: "write" } });
        if (url.includes("/check-runs?") && method === "GET") return json({ check_runs: [] });
        if (url.endsWith("/check-runs") && method === "POST") {
          createCalls += 1;
          createdBody = JSON.parse(bodyText(init?.body));
          return json({ id: 777 }, 201);
        }
        if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
        throw new Error(`unexpected request ${method} ${url}`);
      }) as typeof fetch;
      const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);
      const sha = "a".repeat(40);

      await client.createContinuationCheckRun({ repository: "openai/example", headSha: sha, runId: "run-2" });

      expect(createCalls).toBe(1);
      expect(createdBody).toMatchObject({ head_sha: sha, status: "in_progress", external_id: "run-2" });
    });

    it("createContinuationCheckRun no-ops when a check run already exists for that external_id", async () => {
      let createCalls = 0;
      const sha = "a".repeat(40);
      const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/installation")) return json({ id: 42 });
        if (url.endsWith("/access_tokens")) return tokenResponse({ permissions: { checks: "write" } });
        if (url.includes("/check-runs?") && method === "GET") {
          return json({ check_runs: [{ id: 777, external_id: "run-2" }] });
        }
        if (url.endsWith("/check-runs") && method === "POST") {
          createCalls += 1;
          return json({ id: 999 }, 201);
        }
        if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
        throw new Error(`unexpected request ${method} ${url}`);
      }) as typeof fetch;
      const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);

      await client.createContinuationCheckRun({ repository: "openai/example", headSha: sha, runId: "run-2" });

      expect(createCalls).toBe(0);
    });

    it("completeContinuationCheckRun PATCHes the matching check run with the right conclusion, or no-ops if absent", async () => {
      let patchedBody: Record<string, unknown> | undefined;
      const sha = "a".repeat(40);
      const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/installation")) return json({ id: 42 });
        if (url.endsWith("/access_tokens")) return tokenResponse({ permissions: { checks: "write" } });
        if (url.includes("/check-runs?") && method === "GET") {
          return json({ check_runs: [{ id: 777, external_id: "run-2" }] });
        }
        if (url.endsWith("/check-runs/777") && method === "PATCH") {
          patchedBody = JSON.parse(bodyText(init?.body));
          return json({ id: 777 }, 200);
        }
        if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
        throw new Error(`unexpected request ${method} ${url}`);
      }) as typeof fetch;
      const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);

      await client.completeContinuationCheckRun({
        repository: "openai/example",
        headSha: sha,
        runId: "run-2",
        outcome: "succeeded",
      });

      expect(patchedBody).toEqual({ status: "completed", conclusion: "success" });
    });

    it("completeContinuationCheckRun without a commit looks the check run up on the head branch", async () => {
      const lookedUp: string[] = [];
      let patchedBody: Record<string, unknown> | undefined;
      const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/installation")) return json({ id: 42 });
        if (url.endsWith("/access_tokens")) return tokenResponse({ permissions: { checks: "write" } });
        if (url.includes("/check-runs?") && method === "GET") {
          lookedUp.push(url);
          return json({ check_runs: [{ id: 777, external_id: "run-2" }] });
        }
        if (url.endsWith("/check-runs/777") && method === "PATCH") {
          patchedBody = JSON.parse(bodyText(init?.body));
          return json({ id: 777 }, 200);
        }
        if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
        throw new Error(`unexpected request ${method} ${url}`);
      }) as typeof fetch;
      const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);

      await client.completeContinuationCheckRun({
        repository: "openai/example",
        headRef: "wardby/run-root-run",
        runId: "run-2",
        outcome: "failed",
      });

      expect(lookedUp).toEqual([
        "https://api.github.com/repos/openai/example/commits/wardby%2Frun-root-run/check-runs?per_page=100",
      ]);
      expect(patchedBody).toEqual({ status: "completed", conclusion: "failure" });
      await expect(
        client.completeContinuationCheckRun({ repository: "openai/example", runId: "run-2", outcome: "failed" }),
      ).rejects.toThrow("github_check_run_input_invalid");
    });

    it("mints the checks token separately from the repository token, so a rejection on one never affects the other", async () => {
      const permissionSetsRequested: string[] = [];
      const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/installation")) return json({ id: 42 });
        if (url.endsWith("/access_tokens")) {
          const body = JSON.parse(bodyText(init?.body)) as { permissions: Record<string, string> };
          const key = Object.keys(body.permissions).sort().join(",");
          permissionSetsRequested.push(key);
          // Simulate the Checks permission not having been granted on this installation yet.
          if (key === "checks") return json({ message: "Resource not accessible by integration" }, 422);
          return tokenResponse({ permissions: body.permissions });
        }
        if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
        throw new Error(`unexpected request ${url}`);
      }) as typeof fetch;
      const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);

      await expect(
        client.createContinuationCheckRun({ repository: "openai/example", headSha: "a".repeat(40), runId: "run-2" }),
      ).rejects.toThrow();

      // The real git-push/PR-creation token mint is unaffected by the checks mint's 422 above.
      await expect(client.withRepositoryToken("openai/example", async (token) => token)).resolves.toBe(TOKEN);

      expect(permissionSetsRequested).toEqual(["checks", "contents,pull_requests"]);
    });
  });

  it("rejects non-HTTPS or credentialed API base URLs", () => {
    expect(
      () =>
        new GitHubAppClient({
          appId: "123",
          privateKey: privateKeyPem(),
          apiBaseUrl: "http://api.github.com",
        }),
    ).toThrow("github_api_base_url_invalid");
    expect(
      () =>
        new GitHubAppClient({
          appId: "123",
          privateKey: privateKeyPem(),
          apiBaseUrl: "https://token@api.github.com",
        }),
    ).toThrow("github_api_base_url_invalid");
    expect(
      () =>
        new GitHubAppClient({
          appId: "123",
          privateKey: privateKeyPem(),
          apiVersion: "latest\r\nx-injected: true",
        }),
    ).toThrow("github_api_version_invalid");
  });

  it("mints exactly the requested permission set for withScopedToken and always revokes", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/repos/openai/example/installation")) return json({ id: 42 });
      if (url.endsWith("/app/installations/42/access_tokens")) {
        return tokenResponse({ permissions: { contents: "read", pull_requests: "read", metadata: "read" } });
      }
      if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);

    await expect(
      client.withScopedToken("openai/example", { contents: "read", pull_requests: "read" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(JSON.parse(bodyText(calls[1].init?.body))).toEqual({
      repositories: ["example"],
      permissions: { contents: "read", pull_requests: "read" },
    });
    expect(calls.at(-1)?.init?.method).toBe("DELETE");
  });

  it("reports an uninstalled repository and an ungrantable permission distinctly", async () => {
    const notInstalled = vi.fn(async () => json({ message: "Not Found" }, 404)) as unknown as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, notInstalled, () => NOW);
    await expect(client.withScopedToken("openai/example", { checks: "write" }, async () => 1)).rejects.toThrow(
      "github_app_not_installed",
    );

    const ungrantable = vi.fn(async (input: string) =>
      String(input).endsWith("/installation") ? json({ id: 42 }) : json({ message: "Unprocessable" }, 422),
    ) as unknown as typeof fetch;
    const client2 = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, ungrantable, () => NOW);
    await expect(client2.withScopedToken("openai/example", { issues: "write" }, async () => 1)).rejects.toThrow(
      "github_installation_token_scope_invalid",
    );
  });

  it("reads and caches the App identity", async () => {
    const fetchMock = vi.fn(async () =>
      json({ id: 777, slug: "wardby", owner: { login: "Acme" } }),
    ) as unknown as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);
    await expect(client.appIdentity()).resolves.toEqual({
      id: 777,
      slug: "wardby",
      ownerLogin: "Acme",
    });
    await client.appIdentity();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-reads the App identity when fresh and replaces the cached value", async () => {
    let owner = "Acme";
    const fetchMock = vi.fn(async () =>
      json({ id: 777, slug: "wardby", owner: { login: owner } }),
    ) as unknown as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);
    await expect(client.appIdentity()).resolves.toMatchObject({ ownerLogin: "Acme" });
    owner = "acme-labs";
    await expect(client.appIdentity()).resolves.toMatchObject({ ownerLogin: "Acme" });
    await expect(client.appIdentity({ fresh: true })).resolves.toMatchObject({ ownerLogin: "acme-labs" });
    await expect(client.appIdentity()).resolves.toMatchObject({ ownerLogin: "acme-labs" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not cache a rejected fresh read", async () => {
    let fail = false;
    const fetchMock = vi.fn(async () =>
      fail ? json({ message: "boom" }, 500) : json({ id: 777, slug: "wardby", owner: { login: "Acme" } }),
    ) as unknown as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);
    await client.appIdentity();
    fail = true;
    await expect(client.appIdentity({ fresh: true })).rejects.toThrow();
    fail = false;
    await expect(client.appIdentity()).resolves.toMatchObject({ ownerLogin: "Acme" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects an App identity without a valid owner login", async () => {
    const fetchMock = vi.fn(async () =>
      json({ id: 777, slug: "wardby", owner: { login: "*" } }),
    ) as unknown as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);
    await expect(client.appIdentity()).rejects.toThrow("github_api_invalid_response");
  });
});

describe("GitHubAppClient.deleteInstallation", () => {
  it("deletes the installation with the App JWT and accepts 204", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);
    await client.deleteInstallation(123);
    expect(calls[0].url).toMatch(/\/app\/installations\/123$/);
    expect(calls[0].init.method).toBe("DELETE");
    expect(String((calls[0].init.headers as Record<string, string>).authorization)).toMatch(/^Bearer ey/);
  });

  it("rejects a non-positive id without calling GitHub", async () => {
    const fetchMock = vi.fn() as unknown as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);
    await expect(client.deleteInstallation(0)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("pullRequestBody length", () => {
  const base = { runId: "run-1", repository: "openai/example", baseRef: "main", headRef: "wardby/run-run-1" };

  it("truncates a long summary so the body fits GitHub's limit, keeping the other sections", () => {
    const summary = Array.from({ length: 3000 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
    const tests = [{ command: "npm test", outcome: "passed" as const }];
    const body = pullRequestBody({ ...base, summary, tests });
    expect(body.length).toBeLessThanOrEqual(MAX_PULL_REQUEST_BODY_CHARS);
    expect(body).toContain("[summary truncated]");
    expect(body.startsWith("<!-- wardby:run-1 -->")).toBe(true);
    expect(body).toContain("- `npm test`: passed");
  });

  it("leaves a body within the limit unchanged", () => {
    const body = pullRequestBody({ ...base, summary: "Added a cart." });
    expect(body).toContain("Added a cart.");
    expect(body).not.toContain("[summary truncated]");
  });
});

describe("pullRequestBody refusal warning", () => {
  const base = { runId: "run-1", repository: "openai/example", baseRef: "main", headRef: "wardby/run-run-1" };

  it("warns above the summary, grouped by reason, and names a changed lock file", () => {
    const body = pullRequestBody({
      ...base,
      summary: "Added a cart.",
      packageRefusals: [
        { ecosystem: "npm", name: "braces", reason: "wardby_version_filtered" },
        { ecosystem: "npm", name: "fill-range", reason: "wardby_package_not_allowed" },
        { ecosystem: "npm", name: "is-number", reason: "wardby_package_not_allowed" },
      ],
      changedLockfiles: ["package-lock.json"],
    });
    const warning = body.indexOf("**Dependency install incomplete.**");
    expect(warning).toBeGreaterThan(-1);
    expect(warning).toBeLessThan(body.indexOf("Added a cart."));
    expect(body).toContain("> - npm `braces`: `wardby_version_filtered` (withheld:");
    expect(body).toContain(
      "> - npm `fill-range`, npm `is-number`: `wardby_package_not_allowed` (not on the allowlist, or only reachable through a refused package; the owner must allowlist it)",
    );
    expect(body).toContain("`package-lock.json` changed in this run and may be incomplete");
  });

  it('the banner explains the pending code with "the owner must allowlist it"', () => {
    const body = pullRequestBody({
      ...base,
      packageRefusals: [{ ecosystem: "npm", name: "expo", reason: "wardby_package_not_allowed_pending" }],
    });
    expect(body).toContain("> - npm `expo`: `wardby_package_not_allowed_pending` (");
    expect(body).toContain("the owner must allowlist it");
    expect(body).not.toContain("usually transient");
  });

  it('the banner no longer calls graph_incomplete "usually transient" for an unreached name', () => {
    const body = pullRequestBody({
      ...base,
      packageRefusals: [
        { ecosystem: "npm", name: "expo", reason: "wardby_graph_incomplete" },
        { ecosystem: "npm", name: "huge", reason: "wardby_graph_limit" },
      ],
    });
    expect(body).not.toContain("usually transient");
    expect(body).toContain("still being checked against the allowed packages' dependency graph; retry shortly");
    expect(body).toContain(
      "not reached before the run's dependency graph walk hit its package limit; the owner must allowlist it directly",
    );
  });

  it("does not mention lock files when none changed", () => {
    const body = pullRequestBody({
      ...base,
      packageRefusals: [{ ecosystem: "pypi", name: "annotated-doc", reason: "wardby_package_not_allowed" }],
    });
    expect(body).toContain("**Dependency install incomplete.**");
    expect(body).not.toContain("may be incomplete: a clean install");
  });

  it("has no warning without refusals, even when a lock file changed", () => {
    const body = pullRequestBody({ ...base, changedLockfiles: ["package-lock.json"] });
    expect(body).not.toContain("Dependency install incomplete");
  });

  it("caps the names shown per reason", () => {
    const packageRefusals = Array.from({ length: 12 }, (_, i) => ({
      ecosystem: "npm",
      name: `p${i}`,
      reason: "wardby_package_not_allowed",
    }));
    expect(pullRequestBody({ ...base, packageRefusals })).toContain("npm `p7` and 4 more:");
  });
});

describe("pullRequestBody package audit mode", () => {
  const base = { runId: "run-1", repository: "openai/example", baseRef: "main", headRef: "wardby/run-run-1" };
  const entries = [
    { ecosystem: "npm", name: "expo-dev-client", version: "5.1.2", size: 41210, relation: "top-level" as const },
    {
      ecosystem: "npm",
      name: "expo-dev-launcher",
      version: "5.1.1",
      size: 90231,
      relation: "transitive" as const,
      via: "expo-dev-client",
    },
  ];
  const lodash = {
    ecosystem: "npm",
    name: "lodash",
    version: "4.17.20",
    size: 1200,
    relation: "allowed" as const,
    advisories: [{ id: "GHSA-35jh-r3h4-6jhm", severity: "HIGH", summary: "Command injection in lodash" }],
  };

  it("puts a caution banner above the summary and lists the names to approve", () => {
    const body = pullRequestBody({ ...base, summary: "Added a dev client.", packageAudit: { mode: "audit", entries } });
    const banner = body.indexOf("> [!CAUTION]");
    expect(banner).toBeGreaterThan(-1);
    expect(banner).toBeLessThan(body.indexOf("Added a dev client."));
    expect(body).toContain("**Package audit mode (`audit`) was on for this run.**");
    expect(body).toContain("**Packages outside the allowlist**");
    expect(body).toContain("- npm `expo-dev-client` (and 1 dependency)");
    expect(body).not.toContain("Served despite advisories");
  });

  it("adds the advisory table in full mode", () => {
    const body = pullRequestBody({ ...base, packageAudit: { mode: "full", entries: [...entries, lodash] } });
    expect(body).toContain("**Served despite advisories:**");
    expect(body).toContain("| npm `lodash` | `4.17.20` | `GHSA-35jh-r3h4-6jhm` | HIGH |");
  });

  it("says so in one line when the mode was on and nothing was audited", () => {
    const body = pullRequestBody({ ...base, packageAudit: { mode: "audit", entries: [] } });
    expect(body).toContain("> [!CAUTION]");
    expect(body).toContain("nothing outside the allowlist was installed");
  });

  it("has no banner when the mode was off", () => {
    expect(pullRequestBody({ ...base, summary: "x" })).not.toContain("[!CAUTION]");
  });

  it("neutralises a hostile name", () => {
    const body = pullRequestBody({
      ...base,
      packageAudit: {
        mode: "audit",
        entries: [{ ecosystem: "npm", name: "evil`](x) @team", version: "1.0.0", size: 1, relation: "top-level" }],
      },
    });
    expect(body).toContain("- npm `evil ](x) @\u200bteam`");
    expect(body).not.toContain("@team");
  });

  it("falls back to a fixed banner when the audit report cannot be rendered", () => {
    const body = pullRequestBody({
      ...base,
      summary: "x",
      packageAudit: { mode: "audit", entries: null as never },
    });
    expect(body).toContain("> [!CAUTION]\n> **Package audit mode was on for this run.**");
    expect(body.indexOf("[!CAUTION]")).toBeLessThan(body.indexOf("x"));
  });

  it("is kept when the packages section is dropped for size", () => {
    const body = pullRequestBody(
      {
        ...base,
        packages: [{ ecosystem: "npm", name: "zod", version: "4.0.0" }],
        packageAudit: { mode: "audit", entries },
      },
      { omitPackages: true },
    );
    expect(body).toContain("**Packages outside the allowlist**");
    expect(body).not.toContain("Packages installed during this run");
  });
});

describe("pullRequestBody dependency cache line", () => {
  const base = { runId: "run-1", repository: "openai/example", baseRef: "main", headRef: "wardby/run-run-1" };

  it("names the restored folders in the packages section, the root as the repo root", () => {
    const body = pullRequestBody({
      ...base,
      packages: [{ ecosystem: "npm", name: "left-pad", version: "1.3.0" }],
      restoredDependencies: [".", "web/client"],
    });
    expect(body).toContain("Dependency cache: restored `node_modules` for the repo root, `web/client`.");
    expect(body.indexOf("Dependency cache:")).toBeLessThan(body.indexOf("<details>"));
  });

  it("shows the line on its own when no packages were installed", () => {
    expect(pullRequestBody({ ...base, restoredDependencies: ["."] })).toContain(
      "Dependency cache: restored `node_modules` for the repo root.",
    );
  });

  it("has no line without restored folders, and drops a folder that isn't a plain path", () => {
    expect(pullRequestBody({ ...base })).not.toContain("Dependency cache");
    expect(pullRequestBody({ ...base, restoredDependencies: ["a`b", "x\ny"] })).not.toContain("Dependency cache");
  });
});

describe("pullRequestBody packages section", () => {
  const base = { runId: "run-1", repository: "openai/example", baseRef: "main", headRef: "wardby/run-run-1" };

  it("lists at most 100 packages and 100 refusals, then points at get_run, staying well under 65,536 chars", () => {
    const packages = Array.from({ length: 2000 }, (_, i) => ({
      ecosystem: "npm",
      name: `@scope-${i}/package-with-a-fairly-long-name-${i}`,
      version: `1.${i}.0`,
    }));
    const packageRefusals = Array.from({ length: 2000 }, (_, i) => ({
      ecosystem: "npm",
      name: `refused-package-with-a-long-name-${i}`,
      reason: "wardby_package_not_allowed",
    }));
    const body = pullRequestBody({ ...base, packages, packageRefusals });
    expect(body.length).toBeLessThan(40_000);
    expect(body).toContain("<summary>Packages installed during this run (2000)</summary>");
    expect(body).toContain("- npm `@scope-99/package-with-a-fairly-long-name-99@1.99.0`");
    expect(body).not.toContain("@scope-100/");
    expect(body).toContain("- npm `refused-package-with-a-long-name-99`");
    expect(body).not.toContain("refused-package-with-a-long-name-100`");
    expect(body.match(/…and 1900 more — see get_run for the full list/g)).toHaveLength(2);
  });

  it("bounds the section even when entries are pathologically long", () => {
    const packages = Array.from({ length: 100 }, (_, i) => ({
      ecosystem: "npm",
      name: "x".repeat(5000) + i,
      version: "1.0.0",
    }));
    const body = pullRequestBody({ ...base, packages });
    expect(body.length).toBeLessThan(20_000);
    expect(body).toMatch(/…and \d+ more — see get_run for the full list/);
  });

  it("lists accepted advisories only when a package was served by waiving one", () => {
    const packages = [
      { ecosystem: "npm", name: "node-forge", version: "1.4.0", acceptedAdvisories: ["GHSA-86w9-cpqp-85rv"] },
      { ecosystem: "npm", name: "react", version: "19.0.0" },
    ];
    const body = pullRequestBody({ ...base, packages });
    expect(body).toContain("<summary>Packages installed during this run (2)</summary>");
    expect(body).toContain("**Accepted advisories**");
    expect(body).toContain("- `node-forge@1.4.0`: `GHSA-86w9-cpqp-85rv`");
    expect(body).not.toContain("`react@19.0.0`:");

    const without = pullRequestBody({ ...base, packages: [{ ecosystem: "npm", name: "react", version: "19.0.0" }] });
    expect(without).toContain("<summary>Packages installed during this run (1)</summary>");
    expect(without).not.toContain("Accepted advisories");
    const empty = pullRequestBody({
      ...base,
      packages: [{ ecosystem: "npm", name: "react", version: "19.0.0", acceptedAdvisories: [] }],
    });
    expect(empty).not.toContain("Accepted advisories");
  });

  it("caps the accepted advisories list like the others, and drops unsafe ids", () => {
    const packages = Array.from({ length: 300 }, (_, i) => ({
      ecosystem: "npm",
      name: `waived-${i}`,
      version: "1.0.0",
      acceptedAdvisories: [`GHSA-${i}-xyz`, "bad`id"],
    }));
    const body = pullRequestBody({ ...base, packages });
    expect(body).toContain("- `waived-99@1.0.0`: `GHSA-99-xyz`");
    expect(body).not.toContain("`waived-100@1.0.0`:");
    expect(body).not.toContain("bad`id");
    expect(body.match(/…and 200 more — see get_run for the full list/g)).toHaveLength(2);
  });

  it("drops accepted advisory ids that are not policy-shaped ids", () => {
    const body = pullRequestBody({
      ...base,
      packages: [
        {
          ecosystem: "npm",
          name: "pkg",
          version: "1.0.0",
          acceptedAdvisories: ["GHSA-aaaa-bbbb", "[x](https://e)", "@someone", "</details>"],
        },
      ],
    });
    expect(body).toContain("- `pkg@1.0.0`: `GHSA-aaaa-bbbb`");
    expect(body).not.toContain("https://e");
    expect(body).not.toContain("@someone");
    expect(body.match(/<\/details>/g)).toHaveLength(1);
  });

  it("omits the section, never throws, when the package report cannot be rendered", () => {
    const input = {
      ...base,
      summary: "Did the thing.",
      get packages(): PullRequestInput["packages"] {
        throw new Error("malformed report");
      },
    } as PullRequestInput;
    const body = pullRequestBody(input);
    expect(body).toContain("Did the thing.");
    expect(body).not.toContain("<details>");
  });
});

describe("pull request issue reference", () => {
  const base = { runId: "run-1", repository: "openai/example", baseRef: "main", headRef: "wardby/run-run-1" };
  const issue = { key: "PROJ-123", url: "https://example.atlassian.net/browse/PROJ-123", trackerName: "Jira" };

  it("names the tracker only when one is given", () => {
    const body = pullRequestBody({ ...base, issue: { key: issue.key, url: issue.url } });
    expect(body.split("\n\n")[1]).toBe("Resolves issue [PROJ-123](https://example.atlassian.net/browse/PROJ-123)");
  });

  it("drops a tracker name that is not a plain word or two", () => {
    for (const trackerName of ["", "  ", "[x](http://evil)", "Jira\n# x", "a".repeat(41)]) {
      const body = pullRequestBody({ ...base, issue: { ...issue, trackerName } });
      expect(body.split("\n\n")[1]).toBe("Resolves issue [PROJ-123](https://example.atlassian.net/browse/PROJ-123)");
    }
  });

  it("keeps its key pattern in step with the issue trackers' ISSUE_KEY", () => {
    expect(PR_ISSUE_KEY.source).toBe(ISSUE_KEY.source);
    expect(PR_ISSUE_KEY.flags).toBe(ISSUE_KEY.flags);
  });

  it("prefixes the title with the key, keeping the model tag after it", () => {
    expect(pullRequestTitle({ ...base, issue })).toBe("[PROJ-123] Wardby run run-1");
    expect(pullRequestTitle({ ...base, tag: "fix-login", issue })).toBe("[PROJ-123] [fix-login] Wardby run run-1");
    expect(pullRequestTitle({ ...base, tag: "fix-login" })).toBe("[fix-login] Wardby run run-1");
  });

  it("puts the issue link first, right after the hidden run marker", () => {
    const body = pullRequestBody({ ...base, summary: "Did it.", issue });
    expect(body.split("\n\n").slice(0, 3)).toEqual([
      "<!-- wardby:run-1 -->",
      "Resolves Jira issue [PROJ-123](https://example.atlassian.net/browse/PROJ-123)",
      "Did it.",
    ]);
    expect(pullRequestBody({ ...base, summary: "Did it." })).not.toContain("Resolves");
  });

  it("names a same-repository GitHub issue as `From issue #N` in the same place, never as a closing keyword", () => {
    const body = pullRequestBody({ ...base, summary: "Did it.", issueNumber: 12 });
    expect(body.split("\n\n").slice(0, 3)).toEqual(["<!-- wardby:run-1 -->", "From issue #12", "Did it."]);
    expect(hasClosingKeyword(body)).toBe(false);
    expect(pullRequestTitle({ ...base, issueNumber: 12 })).toBe("Wardby run run-1");
    // A tracker issue's line wins; a bad number renders nothing.
    expect(pullRequestBody({ ...base, summary: "Did it.", issue, issueNumber: 12 })).not.toContain("issue #12");
    for (const issueNumber of [0, -1, 1.5, Number.NaN]) {
      expect(pullRequestBody({ ...base, summary: "Did it.", issueNumber })).not.toContain("From issue");
    }
    // The Related section still goes right after the issue line.
    const block = `${RELATED_SECTION_START}\nA\n${RELATED_SECTION_END}`;
    expect(upsertRelatedSection(body, block)).toBe(
      `<!-- wardby:run-1 -->\n\nFrom issue #12\n\n${block}\n\n${body.split("\n\n").slice(2).join("\n\n")}`,
    );
  });

  it("leaves closing to the agent: a plan's `Refs #N` stays non-closing, a `Resolves #N` it writes still closes", () => {
    const plan = pullRequestBody({ ...base, summary: "Plan only.\n\nRefs #12", issueNumber: 12 });
    expect(plan).toContain("From issue #12");
    expect(hasClosingKeyword(plan)).toBe(false);
    const build = pullRequestBody({ ...base, summary: "Built it.\n\nResolves #12", issueNumber: 12 });
    expect(build.match(/Resolves #12/g)).toHaveLength(1);
    expect(hasClosingKeyword(build)).toBe(true);
  });

  it("drops a malformed key from both title and body", () => {
    for (const key of ["proj-1", "PROJ-0", "PROJ-1\n# x", "[PROJ-1]", "PROJ", "a b-1"]) {
      expect(pullRequestTitle({ ...base, issue: { key, url: issue.url } })).toBe("Wardby run run-1");
      expect(pullRequestBody({ ...base, issue: { key, url: issue.url } })).not.toContain("Resolves");
    }
  });

  it("keeps the title prefix but omits the link when the url is missing or not https", () => {
    for (const url of [
      undefined,
      "http://example.atlassian.net/browse/PROJ-123",
      "javascript:alert(1)",
      "https://x/a b",
    ]) {
      const input = { ...base, issue: { key: "PROJ-123", url } };
      expect(pullRequestTitle(input)).toBe("[PROJ-123] Wardby run run-1");
      expect(pullRequestBody(input)).not.toContain("Resolves");
    }
  });

  it("still re-finds the run's existing PR (lookup keys on the run marker, not the title)", async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/installation")) return json({ id: 42 });
      if (url.endsWith("/access_tokens")) return tokenResponse();
      if (url.includes("/pulls?")) {
        return json([
          {
            number: 7,
            html_url: "https://github.com/openai/example/pull/7",
            draft: true,
            title: "Something a person renamed",
            body: "<!-- wardby:run-1 -->\n\nResolves Jira issue [PROJ-123](https://example.atlassian.net/browse/PROJ-123)",
          },
        ]);
      }
      if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
      throw new Error(`unexpected request ${url} ${init?.method}`);
    }) as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);
    await expect(client.createOrFindDraftPullRequest({ ...base, issue })).resolves.toMatchObject({ number: 7 });
    await expect(
      client.createOrFindDraftPullRequest({ ...base, issue: { key: "OTHER-9", url: issue.url } }),
    ).resolves.toMatchObject({ number: 7 });
  });
});

describe("related pull requests section", () => {
  const entries = [
    { repository: "acme/order-service", number: 2, state: "open" as const },
    { repository: "acme/bff", number: 3, state: "merged" as const },
    { repository: "acme/app", number: 4, self: true },
  ];

  it("numbers only open PRs as the suggested merge order and lists merged/closed ones as context", () => {
    const block = renderRelatedSection({
      entries: [...entries, { repository: "acme/notification-service", number: 2, state: "closed" as const }],
      issue: { key: "PROJ-13", url: "https://example.atlassian.net/browse/PROJ-13", trackerName: "Jira" },
    })!;
    expect(block.startsWith(RELATED_SECTION_START)).toBe(true);
    expect(block.endsWith(RELATED_SECTION_END)).toBe(true);
    expect(block).toContain("for Jira issue [PROJ-13](https://example.atlassian.net/browse/PROJ-13)");
    expect(block).toContain("Suggested merge order (the order Wardby's agent opened them in");
    expect(block).toContain("1. [acme/order-service#2](https://github.com/acme/order-service/pull/2) — open");
    expect(block).toContain("2. **This pull request**");
    expect(block).toContain("Already merged or closed (context only):");
    expect(block).toContain("- [acme/bff#3](https://github.com/acme/bff/pull/3) — merged");
    expect(block).toContain(
      "- [acme/notification-service#2](https://github.com/acme/notification-service/pull/2) — closed",
    );
    expect(block.indexOf("2. **This pull request**")).toBeLessThan(block.indexOf("Already merged"));
  });

  it("still renders the context list when every other PR is merged", () => {
    const block = renderRelatedSection({
      entries: [
        { repository: "acme/bff", number: 3, state: "merged" },
        { repository: "acme/app", self: true },
      ],
    })!;
    expect(block).toContain("1. **This pull request**");
    expect(block).toContain("- [acme/bff#3](https://github.com/acme/bff/pull/3) — merged");
  });

  it("renders nothing without another valid pull request", () => {
    expect(renderRelatedSection({ entries: [{ repository: "acme/app", number: 4, self: true }] })).toBeUndefined();
    expect(
      renderRelatedSection({
        entries: [
          { repository: "acme/app", self: true },
          { repository: "acme/x`y", number: 1 },
          { repository: "acme/ok", number: 0 },
          { repository: "not a repo", number: 2 },
        ],
      }),
    ).toBeUndefined();
  });

  it("drops a malformed issue key or a non-https url, keeping a valid key as plain text", () => {
    expect(renderRelatedSection({ entries, issue: { key: "proj-1" } })).not.toContain("proj-1");
    const block = renderRelatedSection({ entries, issue: { key: "PROJ-1", url: "http://x/PROJ-1" } })!;
    expect(block).toContain("for issue PROJ-1");
    expect(block).not.toContain("http://x");
  });

  it("renders the merge-order heading and step labels when any open entry has a mergeOrder, with unordered entries after under 'Not ordered:'", () => {
    const block = renderRelatedSection({
      entries: [
        { repository: "acme/a", number: 1, state: "open", mergeOrder: 1 },
        { repository: "acme/b", number: 2, state: "open", mergeOrder: 2 },
        { repository: "acme/c", number: 3, state: "open", mergeOrder: 2 },
        { repository: "acme/d", number: 4, state: "open" },
        { repository: "acme/bff", number: 3, state: "merged" },
      ],
    })!;
    expect(block).toContain("Merge order (set by the delegating agent; equal steps can merge in either order):");
    expect(block).not.toContain("Suggested merge order (the order Wardby's agent opened them in");
    expect(block).toContain("1. [acme/a#1](https://github.com/acme/a/pull/1) — open — step 1 of 2");
    expect(block).toContain("2. [acme/b#2](https://github.com/acme/b/pull/2) — open — step 2 of 2");
    expect(block).toContain("3. [acme/c#3](https://github.com/acme/c/pull/3) — open — step 2 of 2");
    expect(block).toContain("Not ordered:");
    expect(block).toContain("- [acme/d#4](https://github.com/acme/d/pull/4) — open");
    expect(block).toContain("Already merged or closed (context only):");
    expect(block).toContain("- [acme/bff#3](https://github.com/acme/bff/pull/3) — merged");
    expect(block.indexOf("Merge order")).toBeLessThan(block.indexOf("Not ordered:"));
    expect(block.indexOf("Not ordered:")).toBeLessThan(block.indexOf("Already merged"));
  });

  it("counts steps over merged and closed entries too, so labels stay the same as pull requests merge", () => {
    const block = renderRelatedSection({
      entries: [
        { repository: "acme/a", number: 1, state: "merged", mergeOrder: 1 },
        { repository: "acme/b", number: 2, state: "open", mergeOrder: 2 },
        { repository: "acme/c", number: 3, state: "open", mergeOrder: 3 },
        { repository: "acme/d", number: 4, state: "closed" },
      ],
    })!;
    expect(block).toContain("1. [acme/b#2](https://github.com/acme/b/pull/2) — open — step 2 of 3");
    expect(block).toContain("2. [acme/c#3](https://github.com/acme/c/pull/3) — open — step 3 of 3");
    expect(block).toContain("- [acme/a#1](https://github.com/acme/a/pull/1) — merged — step 1 of 3");
    expect(block).toContain("- [acme/d#4](https://github.com/acme/d/pull/4) — closed\n");
    expect(block).not.toContain("Suggested merge order");
  });

  it("lists open entries under 'Not ordered:' when only a merged entry has a mergeOrder", () => {
    const block = renderRelatedSection({
      entries: [
        { repository: "acme/a", number: 1, state: "merged", mergeOrder: 1 },
        { repository: "acme/b", number: 2, state: "open" },
      ],
    })!;
    expect(block).not.toContain("Merge order (set by the delegating agent");
    expect(block).not.toContain("Suggested merge order");
    expect(block).toContain("Not ordered:\n\n- [acme/b#2](https://github.com/acme/b/pull/2) — open");
    expect(block).toContain("- [acme/a#1](https://github.com/acme/a/pull/1) — merged — step 1 of 1");
  });

  it("stable-sorts ordered entries by mergeOrder regardless of input order (self listed before a lower-step sibling)", () => {
    const block = renderRelatedSection({
      entries: [
        { repository: "acme/b", number: 2, state: "open", mergeOrder: 2 },
        { repository: "acme/a", self: true, mergeOrder: 1 },
      ],
    })!;
    expect(block).toContain("1. **This pull request** — step 1 of 2");
    expect(block).toContain("2. [acme/b#2](https://github.com/acme/b/pull/2) — open — step 2 of 2");
    expect(block.indexOf("1. **This pull request**")).toBeLessThan(block.indexOf("2. [acme/b#2]"));
  });

  it("renders the unordered heading with today's exact wording when no entry has a mergeOrder", () => {
    const block = renderRelatedSection({
      entries: [
        { repository: "acme/a", number: 1, state: "open" },
        { repository: "acme/b", number: 2, state: "open" },
      ],
    });
    expect(block).toBe(
      [
        RELATED_SECTION_START,
        "**Related pull requests**",
        "",
        "Wardby opened these pull requests for the same request.",
        "",
        "Suggested merge order (the order Wardby's agent opened them in; not a guarantee, so check dependencies before merging):",
        "",
        "1. [acme/a#1](https://github.com/acme/a/pull/1) — open",
        "2. [acme/b#2](https://github.com/acme/b/pull/2) — open",
        "",
        "<sub>Written by Wardby from its run records; this section is replaced when the request's runs finish.</sub>",
        RELATED_SECTION_END,
      ].join("\n"),
    );
  });

  it("caps the list and counts the rest", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ repository: `acme/r${i}`, number: i + 1 }));
    const block = renderRelatedSection({ entries: many })!;
    expect(block).toContain("20. [acme/r19#20]");
    expect(block).not.toContain("acme/r20#21");
    expect(block).toContain("…and 5 more");
  });

  it("inserts after the run marker and the Resolves line, then replaces in place", () => {
    const body = "<!-- wardby:run_1 -->\n\nResolves Jira issue [PROJ-13](https://x)\n\nSummary text";
    const first = upsertRelatedSection(body, `${RELATED_SECTION_START}\nA\n${RELATED_SECTION_END}`)!;
    expect(first).toBe(
      `<!-- wardby:run_1 -->\n\nResolves Jira issue [PROJ-13](https://x)\n\n${RELATED_SECTION_START}\nA\n${RELATED_SECTION_END}\n\nSummary text`,
    );
    const second = upsertRelatedSection(first, `${RELATED_SECTION_START}\nB\n${RELATED_SECTION_END}`)!;
    expect(second).toBe(first.replace("\nA\n", "\nB\n"));
    expect(upsertRelatedSection(second, `${RELATED_SECTION_START}\nB\n${RELATED_SECTION_END}`)).toBe(second);
  });

  it("inserts right after the marker without a Resolves line, and handles CRLF bodies edited on github.com", () => {
    const block = `${RELATED_SECTION_START}\nA\n${RELATED_SECTION_END}`;
    expect(upsertRelatedSection("<!-- wardby:run_1 -->\n\nSummary", block)).toBe(
      `<!-- wardby:run_1 -->\n\n${block}\n\nSummary`,
    );
    expect(upsertRelatedSection("<!-- wardby:run_1 -->\r\n\r\nSummary", block)).toBe(
      `<!-- wardby:run_1 -->\n\n${block}\n\nSummary`,
    );
    expect(upsertRelatedSection("<!-- wardby:run_1 -->", block)).toBe(`<!-- wardby:run_1 -->\n\n${block}`);
  });

  it("refuses to write without a leading run marker or with malformed section markers", () => {
    const block = `${RELATED_SECTION_START}\nA\n${RELATED_SECTION_END}`;
    expect(upsertRelatedSection("Summary only", block)).toBeNull();
    expect(upsertRelatedSection(`<!-- wardby:r -->\n\n${RELATED_SECTION_START}\nhalf`, block)).toBeNull();
    expect(
      upsertRelatedSection(`<!-- wardby:r -->\n\n${RELATED_SECTION_END}\n${RELATED_SECTION_START}`, block),
    ).toBeNull();
    expect(upsertRelatedSection("<!-- wardby:r -->", "no markers")).toBeNull();
  });

  it("puts the section into a new PR body after the issue line and before the warning", () => {
    const body = pullRequestBody({
      runId: "run_1",
      repository: "acme/app",
      baseRef: "main",
      headRef: "wardby/run-run_1",
      summary: "Adds it",
      issue: { key: "PROJ-13", url: "https://example.atlassian.net/browse/PROJ-13", trackerName: "Jira" },
      packageRefusals: [{ ecosystem: "npm", name: "left-pad", reason: "wardby_version_filtered" }],
      related: {
        entries: [
          { repository: "acme/bff", number: 3 },
          { repository: "acme/app", self: true },
        ],
      },
    });
    const parts = body.split("\n\n");
    expect(parts[0]).toBe("<!-- wardby:run_1 -->");
    expect(parts[1]).toMatch(/^Resolves Jira issue/);
    expect(parts[2].startsWith(RELATED_SECTION_START)).toBe(true);
    expect(body).toContain("1. [acme/bff#3](https://github.com/acme/bff/pull/3)\n2. **This pull request**");
    expect(body.indexOf(RELATED_SECTION_END)).toBeLessThan(body.indexOf(`**${DEPENDENCY_INSTALL_INCOMPLETE}**`));
  });
});

describe("GitHubAppClient.updatePullRequestDescription", () => {
  const ROOT = "run-1";
  const RUN = "run-2";
  const OLD_SUMMARY = "Adds the knock-knock joke endpoint with a seeded list of jokes and a handler test. Resolves #12";
  const NEW_SUMMARY =
    "Adds the knock-knock joke endpoint, and now also validates the joke id parameter after review. Resolves #12";
  const base = { repository: "openai/example", baseRef: "main", headRef: `wardby/run-${ROOT}` };
  const OLD_TESTS = [{ command: "npm test", outcome: "failed" as const }];
  const NEW_TESTS = [{ command: "npm test", outcome: "passed" as const }];

  function originalBody(extra: Partial<PullRequestInput> = {}): string {
    return pullRequestBody({ ...base, runId: ROOT, summary: OLD_SUMMARY, tests: OLD_TESTS, ...extra });
  }

  function fake(opts: {
    prBody?: string;
    prs?: unknown[];
    comments?: Array<{
      id: number;
      body: string;
      user?: { type: string };
      performed_via_github_app?: { id: number };
      html_url?: string;
    }>;
    patchStatus?: number;
    patchThrows?: boolean;
  }) {
    const pulls: string[] = [];
    const commentPosts: string[] = [];
    const commentPatches: Array<{ id: string; body: string }> = [];
    const commentPages: string[] = [];
    const events: string[] = [];
    let tokenMints = 0;
    let requests = 0;
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests += 1;
      if (url.endsWith("/installation")) return json({ id: 42 });
      if (url.endsWith("/app")) return json({ id: 123, slug: "wardby", owner: { login: "acme" } });
      if (url.endsWith("/access_tokens")) {
        tokenMints += 1;
        return tokenResponse();
      }
      if (url.includes("/pulls?"))
        return json(
          opts.prs ?? [
            { number: 7, html_url: "https://github.com/openai/example/pull/7", body: opts.prBody, draft: false },
          ],
        );
      if (url.endsWith("/pulls/7") && method === "PATCH") {
        if (opts.patchThrows) throw new Error("connection reset");
        const sent = JSON.parse(bodyText(init?.body)).body as string;
        pulls.push(sent);
        events.push("pr-patch");
        return json({ number: 7, body: sent }, opts.patchStatus ?? 200);
      }
      if (url.includes("/issues/7/comments") && method === "GET") {
        commentPages.push(url);
        const page = Number(new URL(url).searchParams.get("page") ?? "1");
        return json((opts.comments ?? []).slice((page - 1) * 100, page * 100));
      }
      if (url.includes("/issues/7/comments") && method === "POST") {
        commentPosts.push(JSON.parse(bodyText(init?.body)).body);
        events.push("comment-post");
        return json({ id: 555, html_url: "https://github.com/openai/example/pull/7#issuecomment-555" }, 201);
      }
      const commentPatch = /\/issues\/comments\/(\d+)$/.exec(url);
      if (commentPatch && method === "PATCH") {
        events.push("comment-patch");
        commentPatches.push({ id: commentPatch[1], body: JSON.parse(bodyText(init?.body)).body });
        return json({ id: Number(commentPatch[1]) });
      }
      if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
      throw new Error(`unexpected request ${method} ${url}`);
    }) as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);
    return {
      client,
      pulls,
      commentPosts,
      commentPatches,
      commentPages,
      events,
      tokenMints: () => tokenMints,
      requests: () => requests,
    };
  }

  function baseline(body: string) {
    return { recordedSha256: descriptionSha256(body), previousAgentText: OLD_SUMMARY, agentTextRunId: ROOT };
  }

  it("createOrFindDraftPullRequest returns descriptionSha256 of the created body, none when found", async () => {
    const createdBody = "<!-- wardby:run-1 -->\n\nAs GitHub stored it.";
    let found = false;
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/installation")) return json({ id: 42 });
      if (url.endsWith("/access_tokens")) return tokenResponse();
      if (url.includes("/pulls?"))
        return json(
          found
            ? [
                {
                  number: 10,
                  html_url: "https://github.com/openai/example/pull/10",
                  body: createdBody,
                  draft: true,
                },
              ]
            : [],
        );
      if (url.endsWith("/pulls") && init?.method === "POST") {
        return json(
          { number: 10, html_url: "https://github.com/openai/example/pull/10", draft: true, body: createdBody },
          201,
        );
      }
      if (url.endsWith("/installation/token")) return new Response(null, { status: 204 });
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);
    const input = { ...base, runId: ROOT, summary: "A summary that differs from the response body." };

    await expect(client.createOrFindDraftPullRequest(input)).resolves.toEqual({
      number: 10,
      url: "https://github.com/openai/example/pull/10",
      descriptionSha256: descriptionSha256(createdBody),
    });
    found = true;
    await expect(client.createOrFindDraftPullRequest(input)).resolves.toEqual({
      number: 10,
      url: "https://github.com/openai/example/pull/10",
    });
  });

  it("replaces agent text and refreshes Tests/Packages/marker on an unedited PR", async () => {
    const current = originalBody();
    const { client, pulls, commentPosts, tokenMints } = fake({ prBody: current });

    const result = await client.updatePullRequestDescription({
      ...base,
      rootRunId: ROOT,
      runId: RUN,
      summary: NEW_SUMMARY,
      tests: NEW_TESTS,
      packages: [{ ecosystem: "npm", name: "zod", version: "4.0.0" }],
      baseline: baseline(current),
    });

    expect(pulls).toHaveLength(1);
    const patched = pulls[0];
    expect(patched.startsWith(`<!-- wardby:${ROOT} -->\n`)).toBe(true);
    expect(patched).toContain(NEW_SUMMARY);
    expect(patched).not.toContain(OLD_SUMMARY);
    expect(patched).toContain("`npm test`: passed");
    expect(patched).not.toContain("`npm test`: failed");
    expect(patched).toContain("- npm `zod@4.0.0`");
    expect(patched.endsWith(`<!-- wardby-latest:${RUN} -->`)).toBe(true);
    expect(result).toEqual({ kind: "replaced", sha256: descriptionSha256(patched), agentTextRunId: RUN });
    expect(commentPosts).toHaveLength(0);
    expect(tokenMints()).toBe(1);
  });

  it("keeps previous agent text and refreshes sections when the final message is empty", async () => {
    const current = originalBody();
    const { client, pulls } = fake({ prBody: current });

    const result = await client.updatePullRequestDescription({
      ...base,
      rootRunId: ROOT,
      runId: RUN,
      summary: "   ",
      tests: NEW_TESTS,
      baseline: baseline(current),
    });

    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toContain(OLD_SUMMARY);
    expect(pulls[0]).toContain("`npm test`: passed");
    expect(pulls[0].endsWith(`<!-- wardby-latest:${RUN} -->`)).toBe(true);
    expect(result).toEqual({
      kind: "refreshed",
      reason: "empty",
      sha256: descriptionSha256(pulls[0]),
      agentTextRunId: ROOT,
    });
  });

  it("keeps previous agent text when the new message drops `Resolves #N`", async () => {
    const current = originalBody();
    const { client, pulls } = fake({ prBody: current });
    const dropped = "Adds the knock-knock joke endpoint, and now also validates the joke id parameter after review.";

    const result = await client.updatePullRequestDescription({
      ...base,
      rootRunId: ROOT,
      runId: RUN,
      summary: dropped,
      tests: NEW_TESTS,
      baseline: baseline(current),
    });

    expect(pulls[0]).toContain(OLD_SUMMARY);
    expect(pulls[0]).not.toContain(dropped);
    expect(result).toMatchObject({ kind: "refreshed", reason: "missing_closing_keyword", agentTextRunId: ROOT });
  });

  const HEAD = "0123456789abcdef0123456789abcdef01234567";
  /** A comment this App wrote. */
  const ours = (id: number, body: string) => ({
    id,
    body,
    user: { type: "Bot" },
    performed_via_github_app: { id: 123 },
    html_url: `https://github.com/openai/example/pull/7#issuecomment-${id}`,
  });
  const chatter = (from: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({ id: from + i, body: `comment ${from + i}`, user: { type: "User" } }));

  it("posts (once) a fallback comment stamped with the head, and does not PATCH when the hash differs", async () => {
    const written = originalBody();
    const current = `${written}\n\nA reviewer's note added by hand.`;
    const { client, pulls, commentPosts, commentPatches } = fake({ prBody: current });

    const result = await client.updatePullRequestDescription({
      ...base,
      rootRunId: ROOT,
      runId: RUN,
      headSha: HEAD,
      summary: NEW_SUMMARY,
      tests: NEW_TESTS,
      baseline: baseline(written),
    });

    expect(result).toEqual({ kind: "edited_by_hand", commentPosted: true });
    expect(pulls).toHaveLength(0);
    expect(commentPatches).toHaveLength(0);
    expect(commentPosts).toHaveLength(1);
    expect(commentPosts[0].startsWith(`<!-- wardby-description head=${HEAD} -->\n`)).toBe(true);
    expect(commentPosts[0]).toContain(`latest run (\`${RUN}\`)`);
    expect(commentPosts[0]).toContain(NEW_SUMMARY);
  });

  it("a later round edits the same comment in place; an identical body is not re-sent", async () => {
    const written = originalBody();
    const current = `${written}\n\nA reviewer's note added by hand.`;
    const { client, commentPosts, commentPatches } = fake({
      prBody: current,
      comments: [
        ours(98, `<!-- wardby-status:${RUN} -->\n\nworking`),
        ours(99, descriptionFallbackComment(RUN, "an older proposal", HEAD)),
      ],
    });
    const input = {
      ...base,
      rootRunId: ROOT,
      runId: "run-3",
      headSha: HEAD,
      summary: NEW_SUMMARY,
      baseline: baseline(written),
    };

    await expect(client.updatePullRequestDescription(input)).resolves.toEqual({
      kind: "edited_by_hand",
      commentPosted: true,
    });
    expect(commentPosts).toHaveLength(0);
    expect(commentPatches).toHaveLength(1);
    expect(commentPatches[0].id).toBe("99");
    expect(commentPatches[0].body).toContain("latest run (`run-3`)");
    expect(commentPatches[0].body).toContain(NEW_SUMMARY);

    const again = fake({ prBody: current, comments: [ours(99, commentPatches[0].body)] });
    await again.client.updatePullRequestDescription(input);
    expect(again.commentPatches).toHaveLength(0);
    expect(again.commentPosts).toHaveLength(0);
  });

  it("finds the comment past the first 100 comments instead of posting a duplicate", async () => {
    const written = originalBody();
    const { client, commentPosts, commentPatches, commentPages } = fake({
      prBody: `${written}\n\nA reviewer's note added by hand.`,
      comments: [...chatter(1, 150), ours(500, descriptionFallbackComment(RUN, "an older proposal", HEAD))],
    });

    await client.updatePullRequestDescription({
      ...base,
      rootRunId: ROOT,
      runId: "run-3",
      headSha: HEAD,
      summary: NEW_SUMMARY,
      baseline: baseline(written),
    });

    expect(commentPages.length).toBe(2);
    expect(commentPosts).toHaveLength(0);
    expect(commentPatches.map((patch) => patch.id)).toEqual(["500"]);
  });

  it("edits the newest of duplicate comments and points the older ones at it", async () => {
    const written = originalBody();
    const { client, commentPosts, commentPatches } = fake({
      prBody: `${written}\n\nA reviewer's note added by hand.`,
      comments: [
        ours(10, descriptionFallbackComment("run-1", "first proposal", HEAD)),
        ...chatter(11, 5),
        ours(20, descriptionFallbackComment("run-2", "second proposal", HEAD)),
      ],
    });

    await client.updatePullRequestDescription({
      ...base,
      rootRunId: ROOT,
      runId: "run-3",
      headSha: HEAD,
      summary: NEW_SUMMARY,
      baseline: baseline(written),
    });

    expect(commentPosts).toHaveLength(0);
    expect(commentPatches.map((patch) => patch.id)).toEqual(["20", "10"]);
    expect(commentPatches[0].body).toContain(NEW_SUMMARY);
    expect(commentPatches[1].body).toBe(
      supersededDescriptionComment("https://github.com/openai/example/pull/7#issuecomment-20"),
    );
  });

  it("ignores a comment with the earlier per-run marker and posts the pull-request-level one", async () => {
    const written = originalBody();
    const { client, commentPosts, commentPatches } = fake({
      prBody: `${written}\n\nA reviewer's note added by hand.`,
      comments: [ours(99, `<!-- wardby-description:${RUN} -->\n\nold proposal`)],
    });

    await client.updatePullRequestDescription({
      ...base,
      rootRunId: ROOT,
      runId: "run-3",
      headSha: HEAD,
      summary: NEW_SUMMARY,
      baseline: baseline(written),
    });

    expect(commentPatches).toHaveLength(0);
    expect(commentPosts).toHaveLength(1);
    expect(commentPosts[0].startsWith(`<!-- wardby-description head=${HEAD} -->\n`)).toBe(true);
  });

  it("never edits a marked comment a person, an unknown author, or another App wrote", async () => {
    const written = originalBody();
    const current = `${written}\n\nA reviewer's note added by hand.`;
    const { client, commentPosts, commentPatches } = fake({
      prBody: current,
      comments: [
        { id: 97, body: `${DESCRIPTION_COMMENT_MARKER}\n\nwritten by a person`, user: { type: "User" } },
        { id: 96, body: `${DESCRIPTION_COMMENT_MARKER}\n\nno author recorded` },
        {
          id: 95,
          body: descriptionFallbackComment("run-x", "another wardby's proposal", HEAD),
          user: { type: "Bot" },
          performed_via_github_app: { id: 999 },
        },
        { id: 94, body: `${DESCRIPTION_COMMENT_MARKER}\n\na workflow`, user: { type: "Bot" } },
      ],
    });

    const result = await client.updatePullRequestDescription({
      ...base,
      rootRunId: ROOT,
      runId: RUN,
      headSha: HEAD,
      summary: NEW_SUMMARY,
      baseline: baseline(written),
    });

    expect(result).toEqual({ kind: "edited_by_hand", commentPosted: true });
    expect(commentPatches).toHaveLength(0);
    expect(commentPosts).toHaveLength(1);
  });

  it("applying a description marks an earlier proposal comment as applied", async () => {
    const current = originalBody();
    const { client, pulls, commentPosts, commentPatches } = fake({
      prBody: current,
      comments: [ours(99, descriptionFallbackComment("run-0", "an older proposal", HEAD))],
    });

    const result = await client.updatePullRequestDescription({
      ...base,
      rootRunId: ROOT,
      runId: RUN,
      headSha: HEAD,
      summary: NEW_SUMMARY,
      baseline: baseline(current),
    });

    expect(result.kind).toBe("replaced");
    expect(pulls).toHaveLength(1);
    expect(commentPosts).toHaveLength(0);
    expect(commentPatches).toEqual([{ id: "99", body: descriptionAppliedComment(RUN) }]);
  });

  it("applying a description posts no comment when there is none, and leaves an applied one alone", async () => {
    const current = originalBody();
    const none = fake({ prBody: current });
    await none.client.updatePullRequestDescription({
      ...base,
      rootRunId: ROOT,
      runId: RUN,
      summary: NEW_SUMMARY,
      baseline: baseline(current),
    });
    expect(none.commentPosts).toHaveLength(0);
    expect(none.commentPatches).toHaveLength(0);

    const applied = fake({ prBody: current, comments: [ours(99, descriptionAppliedComment("run-0"))] });
    await applied.client.updatePullRequestDescription({
      ...base,
      rootRunId: ROOT,
      runId: RUN,
      summary: NEW_SUMMARY,
      baseline: baseline(current),
    });
    expect(applied.commentPatches).toHaveLength(0);
  });

  it("takes the description back once a person copied the latest proposal in", async () => {
    const written = originalBody();
    // The previous round's proposal, which the author pasted into the description.
    const pasted = pullRequestBody({
      ...base,
      runId: ROOT,
      summary: OLD_SUMMARY,
      tests: NEW_TESTS,
      latestRunId: "run-2",
    });
    const { client, pulls, commentPosts, commentPatches } = fake({
      prBody: pasted.replace(/\n/g, "\r\n"),
      comments: [ours(99, descriptionFallbackComment("run-2", pasted, HEAD))],
    });

    const result = await client.updatePullRequestDescription({
      ...base,
      rootRunId: ROOT,
      runId: "run-3",
      headSha: HEAD,
      summary: NEW_SUMMARY,
      tests: NEW_TESTS,
      // The recorded hash is still of what wardby wrote before the person's edit.
      baseline: baseline(written),
    });

    expect(result).toMatchObject({ kind: "replaced", agentTextRunId: "run-3" });
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toContain(NEW_SUMMARY);
    expect(commentPosts).toHaveLength(0);
    expect(commentPatches).toEqual([{ id: "99", body: descriptionAppliedComment("run-3") }]);
  });

  it("a proposal that differs from the live description is not taken back", async () => {
    const written = originalBody();
    const proposal = pullRequestBody({
      ...base,
      runId: ROOT,
      summary: OLD_SUMMARY,
      tests: NEW_TESTS,
      latestRunId: "run-2",
    });
    const { client, pulls } = fake({
      prBody: `${proposal}\n\nAnd a person's note.`,
      comments: [ours(99, descriptionFallbackComment("run-2", proposal, HEAD))],
    });
    const result = await client.updatePullRequestDescription({
      ...base,
      rootRunId: ROOT,
      runId: "run-3",
      headSha: HEAD,
      summary: NEW_SUMMARY,
      baseline: baseline(written),
    });
    expect(result).toEqual({ kind: "edited_by_hand", commentPosted: true });
    expect(pulls).toHaveLength(0);
  });

  it("proposeDescriptionComment writes the stamped comment only for an edited description", async () => {
    const written = originalBody();
    const edited = fake({ prBody: `${written}\n\nA reviewer's note added by hand.` });
    const input = {
      ...base,
      rootRunId: ROOT,
      runId: RUN,
      headSha: HEAD,
      summary: NEW_SUMMARY,
      baseline: baseline(written),
    };
    await expect(edited.client.proposeDescriptionComment(input)).resolves.toBe(true);
    expect(edited.commentPosts).toHaveLength(1);
    expect(edited.commentPosts[0].startsWith(`<!-- wardby-description head=${HEAD} -->\n`)).toBe(true);
    expect(edited.pulls).toHaveLength(0);

    const unedited = fake({ prBody: written });
    await expect(unedited.client.proposeDescriptionComment(input)).resolves.toBe(false);
    expect(unedited.commentPosts).toHaveLength(0);
    expect(unedited.pulls).toHaveLength(0);
    await expect(unedited.client.proposeDescriptionComment({ ...input, headSha: "not-a-sha" })).resolves.toBe(false);
  });

  it("legacy PR (no recorded hash) matching the reconstructed root body is rewritten", async () => {
    const written = originalBody();
    const { client, pulls, commentPosts } = fake({ prBody: written });

    const result = await client.updatePullRequestDescription({
      ...base,
      rootRunId: ROOT,
      runId: RUN,
      summary: NEW_SUMMARY,
      baseline: {
        recordedSha256: null,
        legacySha256: descriptionSha256(written),
        previousAgentText: OLD_SUMMARY,
        agentTextRunId: ROOT,
      },
    });

    expect(result).toMatchObject({ kind: "replaced", agentTextRunId: RUN });
    expect(pulls).toHaveLength(1);
    expect(pulls[0]).toContain(NEW_SUMMARY);
    expect(commentPosts).toHaveLength(0);
  });

  it("legacy PR with a person's addition, or without a reconstruction, gets the comment", async () => {
    const written = originalBody();
    for (const [prBody, legacySha256] of [
      [`${written}\n\nA reviewer's note added by hand.`, descriptionSha256(written)],
      [written, undefined],
    ] as const) {
      const { client, pulls, commentPosts } = fake({ prBody });
      const result = await client.updatePullRequestDescription({
        ...base,
        rootRunId: ROOT,
        runId: RUN,
        summary: NEW_SUMMARY,
        baseline: {
          recordedSha256: null,
          ...(legacySha256 ? { legacySha256 } : {}),
          previousAgentText: OLD_SUMMARY,
          agentTextRunId: ROOT,
        },
      });
      expect(result).toEqual({ kind: "edited_by_hand", commentPosted: true });
      expect(pulls).toHaveLength(0);
      expect(commentPosts).toHaveLength(1);
    }
  });

  it("titles the Packages section for every run on the pull request", async () => {
    const current = originalBody();
    const { client, pulls } = fake({ prBody: current });

    await client.updatePullRequestDescription({
      ...base,
      rootRunId: ROOT,
      runId: RUN,
      summary: NEW_SUMMARY,
      packages: [
        { ecosystem: "npm", name: "zod", version: "4.0.0" },
        { ecosystem: "npm", name: "vitest", version: "3.2.0" },
      ],
      baseline: baseline(current),
    });

    expect(pulls[0]).toContain("<summary>Packages installed by wardby's runs on this pull request (2)</summary>");
    expect(pulls[0]).not.toContain("during this run");
  });

  it("headRef not wardby/run-<root> → skipped:error, no requests", async () => {
    const current = originalBody();
    const { client, pulls, requests } = fake({ prBody: current });

    const result = await client.updatePullRequestDescription({
      ...base,
      headRef: "feature/someone-elses-branch",
      rootRunId: ROOT,
      runId: RUN,
      summary: NEW_SUMMARY,
      baseline: baseline(current),
    });

    expect(result).toEqual({ kind: "skipped", reason: "error" });
    expect(requests()).toBe(0);
    expect(pulls).toHaveLength(0);
  });

  it("preserves the current Related section verbatim", async () => {
    const written = originalBody({
      related: {
        entries: [
          { repository: "openai/bff", number: 3, state: "open" },
          { repository: "openai/example", self: true },
        ],
      },
    });
    // Another run rewrote the section since (not an edit: the hash ignores it).
    const block = renderRelatedSection({
      entries: [
        { repository: "openai/bff", number: 3, state: "merged" },
        { repository: "openai/example", self: true },
      ],
    })!;
    const current = upsertRelatedSection(written, block)!;
    expect(current).not.toBe(written);
    const { client, pulls } = fake({ prBody: current });

    const result = await client.updatePullRequestDescription({
      ...base,
      rootRunId: ROOT,
      runId: RUN,
      summary: NEW_SUMMARY,
      related: { entries: [{ repository: "openai/other", number: 9 }] },
      baseline: baseline(written),
    });

    expect(result.kind).toBe("replaced");
    expect(pulls[0]).toContain(block);
    expect(pulls[0]).not.toContain("openai/other");
    expect(pulls[0].indexOf(block)).toBeLessThan(pulls[0].indexOf(NEW_SUMMARY));
  });

  it("unchanged body → no PATCH, kind unchanged", async () => {
    const current = originalBody({ latestRunId: RUN, tests: NEW_TESTS });
    const { client, pulls } = fake({ prBody: current });

    const result = await client.updatePullRequestDescription({
      ...base,
      rootRunId: ROOT,
      runId: RUN,
      tests: NEW_TESTS,
      baseline: baseline(current),
    });

    expect(pulls).toHaveLength(0);
    expect(result).toEqual({ kind: "unchanged", sha256: descriptionSha256(current), agentTextRunId: ROOT });
  });

  it("PR closed → skipped:not_open, no PATCH", async () => {
    const current = originalBody();
    const { client, pulls, commentPosts } = fake({ prs: [] });

    const result = await client.updatePullRequestDescription({
      ...base,
      rootRunId: ROOT,
      runId: RUN,
      summary: NEW_SUMMARY,
      baseline: baseline(current),
    });

    expect(result).toEqual({ kind: "skipped", reason: "not_open" });
    expect(pulls).toHaveLength(0);
    expect(commentPosts).toHaveLength(0);
  });

  it("body over 65,536 drops Packages, then truncates the summary keeping its closing line", async () => {
    const current = originalBody();
    const packages = Array.from({ length: 100 }, (_, i) => ({
      ecosystem: "npm",
      name: `a-fairly-long-package-name-${i}`,
      version: "1.0.0",
    }));
    const { client, pulls } = fake({ prBody: current });

    const fits = `${"x".repeat(63_000)}\nResolves #12`;
    const dropped = await client.updatePullRequestDescription({
      ...base,
      rootRunId: ROOT,
      runId: RUN,
      summary: fits,
      packages,
      baseline: baseline(current),
    });
    expect(dropped.kind).toBe("replaced");
    expect(pulls).toHaveLength(1);
    expect(pulls[0].length).toBeLessThanOrEqual(65_536);
    expect(pulls[0]).not.toContain("Packages installed");
    expect(pulls[0]).not.toContain("[summary truncated]");
    expect(pulls[0].endsWith(`<!-- wardby-latest:${RUN} -->`)).toBe(true);

    const long = await client.updatePullRequestDescription({
      ...base,
      rootRunId: ROOT,
      runId: RUN,
      summary: `${Array.from({ length: 4000 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n")}\nResolves #12`,
      packages,
      baseline: baseline(current),
    });
    expect(long.kind).toBe("replaced");
    expect(pulls).toHaveLength(2);
    expect(pulls[1].length).toBeLessThanOrEqual(65_536);
    expect(pulls[1]).toContain("[summary truncated]\n\nResolves #12");
  });

  it("never PATCHes a PR whose body doesn't start with the root marker", async () => {
    const written = originalBody();
    const current = `Context a person wrote above the marker.\n\n${written}`;
    const { client, pulls, commentPosts } = fake({ prBody: current });

    const result = await client.updatePullRequestDescription({
      ...base,
      rootRunId: ROOT,
      runId: RUN,
      summary: NEW_SUMMARY,
      // Even with the hash of the current body recorded.
      baseline: baseline(current),
    });
    expect(result).toEqual({ kind: "edited_by_hand", commentPosted: true });

    // A legacy PR (no recorded hash) counts as edited too.
    const legacy = fake({ prBody: written });
    const legacyResult = await legacy.client.updatePullRequestDescription({
      ...base,
      rootRunId: ROOT,
      runId: RUN,
      summary: NEW_SUMMARY,
      baseline: { recordedSha256: null, previousAgentText: OLD_SUMMARY, agentTextRunId: ROOT },
    });
    expect(legacyResult).toEqual({ kind: "edited_by_hand", commentPosted: true });

    expect(pulls).toHaveLength(0);
    expect(legacy.pulls).toHaveLength(0);
    expect(commentPosts).toHaveLength(1);
    expect(legacy.commentPosts).toHaveLength(1);
  });

  it("PATCH failure → skipped:error, does not throw", async () => {
    const current = originalBody();
    const input = {
      ...base,
      rootRunId: ROOT,
      runId: RUN,
      summary: NEW_SUMMARY,
      baseline: baseline(current),
    };

    await expect(
      fake({ prBody: current, patchStatus: 422 }).client.updatePullRequestDescription(input),
    ).resolves.toEqual({ kind: "skipped", reason: "error" });
    await expect(
      fake({ prBody: current, patchThrows: true }).client.updatePullRequestDescription(input),
    ).resolves.toEqual({ kind: "skipped", reason: "error" });
    await expect(
      fake({ prBody: current }).client.updatePullRequestDescription({ ...input, runId: "../bad" }),
    ).resolves.toEqual({ kind: "skipped", reason: "error" });
  });
});
