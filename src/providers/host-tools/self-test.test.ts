import { describe, expect, it, vi } from "vitest";
import { createSimServer, simRequest } from "../../../tools/wardby-sim/src/server.js";
import { createBitbucketSim, BITBUCKET_API_PREFIX } from "../../../tools/wardby-sim/src/bitbucket/service.js";
import {
  SIM_BITBUCKET_REPO_TOKEN,
  SIM_BITBUCKET_WORKSPACE_TOKEN,
} from "../../../tools/wardby-sim/src/bitbucket/state.js";
import { callHostOperation, hostToolFetch, selfTestHostProvider, type LoadedProvider } from "./self-test.js";

const REPOSITORY = "bitbucket:acme/web";
const BROKER = {
  hosts: ["api.bitbucket.org", "bitbucket.org"],
  placement: { kind: "header", name: "Authorization", format: "Bearer {value}" },
};
const cipher = { decrypt: async (text: string) => text, encrypt: async (text: string) => text, keyId: "k" } as never;
const ZOD = "z.object({}).passthrough()";

const API = "const base = `https://api.bitbucket.org/2.0/repositories/${params.workspace}/${params.repo}`;";
const OK =
  'if (r.status === 404) return { error: "not_found" }; if (r.status === 403) return { error: "forbidden" }; if (r.status === 401) return { error: "unauthorized" }; if (!r.ok) return { error: "unavailable" };';
const PR = `{ number: j.id, title: j.title, body: j.description, author: j.author.account_id, state: j.state === "OPEN" ? "open" : "closed", merged: j.state === "MERGED", draft: j.draft, baseRef: j.destination.branch.name, headRef: j.source.branch.name, headSha: j.source.commit.hash, isFork: false, htmlUrl: j.links.html.href }`;

/** Enough tools to drive the checks; PR 3 ships the real reference tools. */
const TOOLS: Record<string, string> = {
  getPullRequest: `${API} const r = await fetch(\`\${base}/pullrequests/\${params.number}\`, { secrets: ["host"] }); ${OK} const j = await r.json(); return ${PR};`,
  listPullRequestFiles: `${API} const r = await fetch(\`\${base}/pullrequests/\${params.number}/diffstat\`, { secrets: ["host"] }); ${OK} const j = await r.json(); return { files: j.values.map((f) => ({ filename: f.new.path, status: f.status, additions: f.lines_added, deletions: f.lines_removed })), nextPage: null };`,
  getDiff: `${API} let r = await fetch(\`\${base}/pullrequests/\${params.number}/diff\`, { secrets: ["host"] }); if (r.status === 302) r = await fetch(r.headers.get("location"), { secrets: ["host"] }); ${OK} return { diff: await r.text() };`,
  findPullRequest: `${API} const r = await fetch(\`\${base}/pullrequests?q=\${encodeURIComponent('source.branch.name="' + params.headRef + '"')}\`, { secrets: ["host"] }); ${OK} const v = (await r.json()).values; if (!v.length) return { pullRequest: null }; const j = v[0]; return { pullRequest: ${PR} };`,
  readFile: `${API} const r = await fetch(\`\${base}/src/\${params.ref}/\${params.path}\`, { secrets: ["host"] }); if (r.status === 404) return { kind: "not_found" }; ${OK} return { kind: "file", content: await r.text() };`,
  listFiles: `${API} const r = await fetch(\`\${base}/src/\${params.ref}/\`, { secrets: ["host"] }); ${OK} const j = await r.json(); return { entries: j.values.map((e) => ({ path: e.path, type: "file", size: e.size })), nextPage: null };`,
  listComments: `${API} const r = await fetch(\`\${base}/pullrequests/\${params.number}/comments\`, { secrets: ["host"] }); ${OK} return { comments: [], nextPage: null };`,
  listCommitStatuses: `${API} const r = await fetch(\`\${base}/commit/\${params.ref}/statuses\`, { secrets: ["host"] }); ${OK} return { statuses: [], nextPage: null };`,
  getRepositoryPermission: `const r = await fetch(\`https://api.bitbucket.org/2.0/workspaces/\${params.workspace}/permissions/repositories/\${params.repo}?q=\${encodeURIComponent('user.account_id="' + params.accountId + '"')}\`, { secrets: ["host"] }); ${OK} const v = (await r.json()).values; return { permission: v.length ? v[0].permission : "none" };`,
  openPullRequest: `throw new Error("a write must not run");`,
};

function setup(overrides: Partial<LoadedProvider> = {}) {
  const bitbucket = createBitbucketSim();
  const sim = createSimServer({ services: [bitbucket.service] });
  bitbucket.state.addRepo("acme/web", { files: { "README.md": "hi" } });
  bitbucket.state.addPullRequest("acme/web", { id: 4, headRef: "feature", headSha: "abc123" });
  const seen: string[] = [];
  const fetchImpl = vi.fn(async (url: string, init: { method?: string; headers?: Record<string, string> } = {}) => {
    const parsed = new URL(url);
    seen.push(`${init.method ?? "GET"} ${parsed.pathname}`);
    const res = await sim.dispatch(
      simRequest(
        init.method ?? "GET",
        `${BITBUCKET_API_PREFIX}${parsed.pathname}${parsed.search}`,
        undefined,
        init.headers ?? {},
      ),
    );
    const body = Buffer.isBuffer(res.body) ? res.body : Buffer.from(String(res.body ?? ""));
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      statusText: "",
      url,
      headers: res.headers ?? {},
      bodyBase64: body.toString("base64"),
    };
  });
  const provider: LoadedProvider = {
    name: "bitbucket",
    apiHosts: ["api.bitbucket.org"],
    repositoryApiPath: "/2.0/repositories/{repository}",
    permissionApiPath: "/2.0/workspaces/{workspace}/permissions/repositories/{repo}",
    permissionSecret: { ciphertext: SIM_BITBUCKET_WORKSPACE_TOKEN, broker: BROKER },
    credentials: [{ repositoryPattern: "acme/*", secret: { ciphertext: SIM_BITBUCKET_REPO_TOKEN, broker: BROKER } }],
    operations: Object.entries(TOOLS).map(([operation, code]) => ({ operation, code, paramsZod: ZOD })),
    ...overrides,
  };
  return { provider, bitbucket, seen, options: { fetchImpl: fetchImpl as never } };
}

const byOperation = (report: { results: { operation: string; code?: string }[] }) =>
  Object.fromEntries(report.results.map((r) => [r.operation, r]));

describe("selfTestHostProvider", () => {
  it("passes every read-only check, against the simulator", async () => {
    const { provider, bitbucket, options } = setup();
    bitbucket.state.setPermission("acme/web", "acct-1", "write");
    const report = await selfTestHostProvider(
      provider,
      cipher,
      { repository: REPOSITORY, pullRequest: 4, headRef: "feature", accountId: "acct-1" },
      options,
    );
    expect(report.mode).toBe("permission");
    for (const name of [
      "getPullRequest",
      "listPullRequestFiles",
      "getDiff",
      "findPullRequest",
      "readFile",
      "listFiles",
      "listComments",
      "listCommitStatuses",
      "getRepositoryPermission",
    ]) {
      expect(byOperation(report)[name], name).toEqual({ operation: name, outcome: "pass" });
    }
  });

  it("carries no token in a passing report, even when the host echoes it", async () => {
    const { provider, bitbucket, options } = setup();
    bitbucket.state.addPullRequest("acme/web", {
      id: 5,
      title: SIM_BITBUCKET_REPO_TOKEN,
      headRef: "echo",
      headSha: "def456",
    });
    bitbucket.state.setPermission("acme/web", "acct-1", "write");
    const echoed = await callHostOperation(provider, cipher, REPOSITORY, "getPullRequest", { number: 5 }, options);
    expect(echoed.ok).toBe(true);

    const report = await selfTestHostProvider(
      provider,
      cipher,
      { repository: REPOSITORY, pullRequest: 5, headRef: "echo", accountId: "acct-1" },
      options,
    );
    expect(byOperation(report).getPullRequest).toEqual({ operation: "getPullRequest", outcome: "pass" });
    expect(report.results.filter((r) => r.outcome === "fail")).toEqual([]);
    expect(JSON.stringify(report)).not.toContain(SIM_BITBUCKET_REPO_TOKEN);
    expect(JSON.stringify(report)).not.toContain(SIM_BITBUCKET_WORKSPACE_TOKEN);
  });

  it("calls no write", async () => {
    const { provider, seen, options } = setup();
    const report = await selfTestHostProvider(provider, cipher, { repository: REPOSITORY, pullRequest: 4 }, options);
    expect(byOperation(report).openPullRequest).toEqual({
      operation: "openPullRequest",
      outcome: "skipped",
      code: "not_read_only",
    });
    expect(seen.every((line) => line.startsWith("GET "))).toBe(true);
  });

  it("skips what its input doesn't reach, and says so", async () => {
    const { provider, options } = setup();
    const report = await selfTestHostProvider(provider, cipher, { repository: REPOSITORY }, options);
    expect(byOperation(report).getPullRequest).toEqual({
      operation: "getPullRequest",
      outcome: "skipped",
      code: "needs_pull_request",
    });
    expect(byOperation(report).readFile).toEqual({ operation: "readFile", outcome: "skipped", code: "needs_ref" });
    expect(byOperation(report).getRepositoryPermission).toEqual({
      operation: "getRepositoryPermission",
      outcome: "skipped",
      code: "needs_account",
    });
  });

  it("reports a repository token on the permission endpoint as forbidden", async () => {
    const { provider, options } = setup({
      permissionSecret: { ciphertext: SIM_BITBUCKET_REPO_TOKEN, broker: BROKER },
    });
    const report = await selfTestHostProvider(
      provider,
      cipher,
      { repository: REPOSITORY, accountId: "acct-1" },
      options,
    );
    expect(byOperation(report).getRepositoryPermission).toEqual({
      operation: "getRepositoryPermission",
      outcome: "fail",
      code: "host_forbidden",
    });
  });

  it("skips the permission lookup in allowlist mode", async () => {
    const { provider, options } = setup({ permissionSecret: null, permissionApiPath: null });
    const report = await selfTestHostProvider(provider, cipher, { repository: REPOSITORY, accountId: "a" }, options);
    expect(report.mode).toBe("allowlist");
    expect(byOperation(report).getRepositoryPermission.code).toBe("allowlist_mode");
  });

  it("reports a repository no credential covers, and sends nothing", async () => {
    const { provider, seen, options } = setup();
    const report = await selfTestHostProvider(
      provider,
      cipher,
      { repository: "bitbucket:other/web", pullRequest: 4 },
      options,
    );
    expect(byOperation(report).getPullRequest).toEqual({
      operation: "getPullRequest",
      outcome: "fail",
      code: "host_tool_no_credential",
    });
    expect(seen).toEqual([]);
  });

  it("carries no token or tool text in its report", async () => {
    const { provider, options } = setup({
      operations: [
        { operation: "getPullRequest", code: `throw new Error("leak ${SIM_BITBUCKET_REPO_TOKEN}");`, paramsZod: ZOD },
      ],
    });
    const report = await selfTestHostProvider(provider, cipher, { repository: REPOSITORY, pullRequest: 4 }, options);
    const text = JSON.stringify(report);
    expect(text).not.toContain(SIM_BITBUCKET_REPO_TOKEN);
    expect(text).not.toContain("leak");
    expect(byOperation(report).getPullRequest.code).toBe("host_tool_failed");
  });
});

describe("callHostOperation", () => {
  it("won't send the permission credential to a repository operation", async () => {
    const { provider, options } = setup({
      credentials: [],
    });
    const result = await callHostOperation(provider, cipher, REPOSITORY, "getPullRequest", { number: 4 }, options);
    expect(result).toEqual({ ok: false, code: "host_tool_no_credential" });
  });

  it("keeps the permission lookup to the permission path", async () => {
    const { provider, options } = setup({
      operations: [
        {
          operation: "getRepositoryPermission",
          code: `const r = await fetch("https://api.bitbucket.org/2.0/repositories/acme/web", { secrets: ["host"] }); return { permission: "admin" };`,
          paramsZod: ZOD,
        },
      ],
    });
    const result = await callHostOperation(
      provider,
      cipher,
      REPOSITORY,
      "getRepositoryPermission",
      { accountId: "a" },
      options,
    );
    expect(result).toEqual({ ok: false, code: "host_tool_request_denied" });
  });

  it.each([
    ["a mismatched prefix", "zzzzzzzzz:acme/web", "getPullRequest"],
    ["a permission lookup with no repository name", "bitbucket:foo", "getRepositoryPermission"],
    ["a permission lookup with extra segments", "bitbucket:acme/web/extra", "getRepositoryPermission"],
    ["a repository that isn't normalized", "bitbucket:ACME/web", "getPullRequest"],
  ] as const)("denies %s, and sends nothing", async (_name, repository, operation) => {
    const { provider, seen, options } = setup();
    const result = await callHostOperation(
      provider,
      cipher,
      repository,
      operation,
      { number: 4, accountId: "a" },
      options,
    );
    expect(result).toEqual({ ok: false, code: "host_tool_request_denied" });
    expect(seen).toEqual([]);
  });

  it("keeps caller fields from overwriting the repository identity", async () => {
    const { provider, seen, options } = setup();
    const result = await callHostOperation(
      provider,
      cipher,
      REPOSITORY,
      "getPullRequest",
      { number: 4, repository: "acme/other", workspace: "other", repo: "other" },
      options,
    );
    expect(result.ok).toBe(true);
    expect(seen).toEqual(["GET /2.0/repositories/acme/web/pullrequests/4"]);
  });

  it("maps a merged pull request to closed, with merged set", async () => {
    const { provider, bitbucket, options } = setup();
    bitbucket.state.addPullRequest("acme/web", { id: 6, state: "MERGED", headRef: "done", headSha: "fed321" });
    const result = await callHostOperation(provider, cipher, REPOSITORY, "getPullRequest", { number: 6 }, options);
    expect(result).toMatchObject({ ok: true, value: { number: 6, state: "closed", merged: true } });
  });

  it.each([
    ["declaring", "z.object({ number: z.number(), page: z.string().optional() })", "after-2"],
    ["not declaring", "z.object({ number: z.number() })", null],
  ])("passes page to a tool %s it", async (_label, paramsZod, expected) => {
    const { provider, options } = setup({
      operations: [
        {
          operation: "listPullRequestFiles",
          code: `return { files: [], nextPage: params.page ? "after-" + params.page : null };`,
          paramsZod,
        },
      ],
    });
    const result = await callHostOperation(
      provider,
      cipher,
      REPOSITORY,
      "listPullRequestFiles",
      { number: 4, page: "2" },
      options,
    );
    expect(result).toEqual({ ok: true, value: { files: [], nextPage: expected } });
  });

  it("reports an operation with no snapshot", async () => {
    const { provider, options } = setup({ operations: [] });
    expect(await callHostOperation(provider, cipher, REPOSITORY, "getDiff", { number: 4 }, options)).toEqual({
      ok: false,
      code: "host_tool_failed",
    });
  });
});

describe("hostToolFetch", () => {
  it("returns no fetch with the switch off, so the real safeFetch is used", () => {
    expect(hostToolFetch({})).toEqual({ simulated: false });
  });

  it("takes the simulator's fetch only from the switch", () => {
    const result = hostToolFetch({ WARDBY_TEST_SIMULATORS: "1", WARDBY_SIM_BASE_URL: "http://127.0.0.1:9999" });
    expect(result.simulated).toBe(true);
    expect(typeof result.fetchImpl).toBe("function");
  });
});

describe("credentials", () => {
  it("sends no non-sim credential when simulated", async () => {
    const { provider, seen, options } = setup({
      credentials: [{ repositoryPattern: "acme/*", secret: { ciphertext: "real-looking-token", broker: BROKER } }],
    });
    const report = await selfTestHostProvider(
      provider,
      cipher,
      { repository: REPOSITORY, pullRequest: 4 },
      { ...options, simulated: true },
    );
    expect(byOperation(report).getPullRequest).toEqual({
      operation: "getPullRequest",
      outcome: "fail",
      code: "host_tool_no_credential",
    });
    expect(seen).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("real-looking-token");
  });

  it("fails closed when the stored broker is missing", async () => {
    const { provider, seen, options } = setup({
      credentials: [{ repositoryPattern: "acme/*", secret: { ciphertext: SIM_BITBUCKET_REPO_TOKEN, broker: null } }],
    });
    const result = await callHostOperation(provider, cipher, REPOSITORY, "getPullRequest", { number: 4 }, options);
    expect(result).toEqual({ ok: false, code: "host_tool_no_credential" });
    expect(seen).toEqual([]);
  });
});
