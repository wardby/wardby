import { generateKeyPairSync } from "node:crypto";
import { decodeJwt } from "jose";
import { describe, expect, it, vi } from "vitest";
import { GitHubAppClient, pullRequestBody, type PullRequestInput } from "./github.js";

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
    const fetchMock = vi.fn(async () => json({ id: 777, slug: "wardby" })) as unknown as typeof fetch;
    const client = new GitHubAppClient({ appId: "123", privateKey: privateKeyPem() }, fetchMock, () => NOW);
    await expect(client.appIdentity()).resolves.toEqual({ id: 777, slug: "wardby" });
    await client.appIdentity();
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
