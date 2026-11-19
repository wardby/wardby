/**
 * `POST /registry/pypi/-/origins` through RegistryService with the real PyPI adapter, in private-index
 * (JFrog) mode and public mode: the route answers each (project, file) with the file's real upstream
 * address, only for what the run may be served, and never carries a credential.
 */
import { describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../../../core/logger.js", () => ({ logger: { child: () => log } }));

const { createPypiAdapter, pypiAdapter } = await import("../../../coding/registry/pypi.js");
const { capabilityHash } = await import("../proxy.js");
const { RegistryService, MAX_ORIGIN_FILES } = await import("./service.js");
const { MemoryRegistryStore } = await import("./store.js");

const DAY = 86_400_000;
const NOW = new Date("2026-10-19T00:00:00Z");
const OLD = new Date(NOW.getTime() - 30 * DAY).toISOString();
const NEW = new Date(NOW.getTime() - DAY).toISOString();
const JFROG = {
  url: "https://artifacts.example.test/art",
  host: "artifacts.example.test",
  pypi: { repo: "pypi", trustAll: false },
};
const JFROG_INDEX = "https://artifacts.example.test/art/api/pypi/pypi/simple";
const SECRET_UPSTREAM = "upstream-secret-value-1234";
const SECRET_TOKEN = "rrg_token";

interface IndexFile {
  filename: string;
  url: string;
  uploaded?: string;
}
const entry = ({ filename, url, uploaded }: IndexFile) => ({
  filename,
  url,
  hashes: { sha256: "a".repeat(64) },
  "upload-time": uploaded ?? OLD,
});

function setup(options: { jfrog?: boolean; allowlist?: string[]; index: Record<string, IndexFile[]> }) {
  const store = new MemoryRegistryStore();
  store.contexts.set(capabilityHash(SECRET_TOKEN), {
    runId: "run-1",
    deadlineAt: new Date(NOW.getTime() + DAY),
    allowlist: { pypi: options.allowlist ?? ["fresh-logging", "requests"] },
    policy: {},
    repository: "owner/repo",
    cacheImage: null,
    dependencyCache: false,
    packageAudit: null,
  });
  const base = options.jfrog === false ? "https://pypi.org/simple/" : `${JFROG_INDEX}/`;
  const upstream = vi.fn(async (url: string) => {
    for (const [name, files] of Object.entries(options.index)) {
      if (url === `${base}${name}/`) return Response.json({ name, files: files.map(entry) });
    }
    return new Response("not found", { status: 404 });
  });
  const adapter = options.jfrog === false ? pypiAdapter : createPypiAdapter(JFROG);
  const service = new RegistryService({
    adapters: new Map([["pypi", adapter]]),
    store,
    audit: { audit: async () => ({ withheld: () => [], waived: () => [], reported: () => [] }) },
    upstream,
    proxyBase: "http://wardby-proxy:8787/registry/",
    limits: { maxFileBytes: 1_000_000, maxTotalBytes: 10_000_000, maxFiles: 100, idleTimeoutMs: 1_000 },
    now: () => NOW,
  });
  const origins = async (body: unknown, token = SECRET_TOKEN, ecosystem = "pypi") => {
    const response = await service.origins({
      ecosystem,
      token,
      readBody: async () => (typeof body === "string" ? body : JSON.stringify(body)),
      signal: new AbortController().signal,
    });
    const text = (response as { body: string }).body;
    return { status: response.status, text, json: JSON.parse(text) as Record<string, any> };
  };
  return { service, store, origins, upstream };
}

const ask = (name: string, filename: string) => ({ files: [{ name, filename }] });
const WHEEL = "fresh_logging-2.3.21-py3-none-any.whl";

describe("the origins route, private index", () => {
  const index = {
    "fresh-logging": [
      // Artifactory's hosted file URL, relative to the index page.
      { filename: WHEEL, url: "../../fresh_logging/2.3.21/" + WHEEL },
      {
        filename: "fresh_logging-2.3.22-py3-none-any.whl",
        url: "../../fresh_logging/2.3.22/fresh_logging-2.3.22-py3-none-any.whl",
      },
    ],
    requests: [
      {
        filename: "requests-2.32.3-py3-none-any.whl",
        url: "../../packages/packages/71/70/abcdef/requests-2.32.3-py3-none-any.whl",
      },
      { filename: "requests-2.32.3.tar.gz", url: "../../packages/packages/71/70/abcdef/requests-2.32.3.tar.gz" },
    ],
  };

  it("answers a private package and a mirrored public one with the real Artifactory address, and the index", async () => {
    const { origins } = setup({ index });
    const { status, json } = await origins({
      files: [
        { name: "fresh-logging", filename: WHEEL },
        { name: "requests", filename: "requests-2.32.3-py3-none-any.whl" },
        { name: "requests", filename: "requests-2.32.3.tar.gz" },
      ],
    });
    expect(status).toBe(200);
    expect(json.index).toBe(JFROG_INDEX);
    expect(json.files).toEqual([
      {
        name: "fresh-logging",
        filename: WHEEL,
        url: `https://artifacts.example.test/art/api/pypi/pypi/fresh_logging/2.3.21/${WHEEL}`,
      },
      {
        name: "requests",
        filename: "requests-2.32.3-py3-none-any.whl",
        url: "https://artifacts.example.test/art/api/pypi/pypi/packages/packages/71/70/abcdef/requests-2.32.3-py3-none-any.whl",
      },
      {
        name: "requests",
        filename: "requests-2.32.3.tar.gz",
        url: "https://artifacts.example.test/art/api/pypi/pypi/packages/packages/71/70/abcdef/requests-2.32.3.tar.gz",
      },
    ]);
  });

  it("answers a version no lock ever named (an upgrade) the same way", async () => {
    const { origins } = setup({ index });
    const { json } = await origins(ask("fresh-logging", "fresh_logging-2.3.22-py3-none-any.whl"));
    expect(json.files[0].url).toBe(
      "https://artifacts.example.test/art/api/pypi/pypi/fresh_logging/2.3.22/fresh_logging-2.3.22-py3-none-any.whl",
    );
  });

  it("accepts a project name in any spelling and answers with the name as asked", async () => {
    const { origins } = setup({ index });
    const { json } = await origins(ask("Fresh_Logging", WHEEL));
    expect(json.files[0]).toMatchObject({ name: "Fresh_Logging", filename: WHEEL });
    expect(json.files[0].url).toContain("/fresh_logging/2.3.21/");
  });

  it("refuses a project the run was never allowed, without asking upstream for it", async () => {
    const { origins, upstream } = setup({
      index: {
        ...index,
        secretpkg: [{ filename: "secretpkg-1-py3-none-any.whl", url: "../../x/secretpkg-1-py3-none-any.whl" }],
      },
    });
    const { status, json } = await origins(ask("secretpkg", "secretpkg-1-py3-none-any.whl"));
    expect(status).toBe(200);
    expect(json.files[0]).toEqual({
      name: "secretpkg",
      filename: "secretpkg-1-py3-none-any.whl",
      error: "wardby_origin_not_allowed",
    });
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses a file the index does not list for an allowed project", async () => {
    const { origins } = setup({ index });
    const { json } = await origins(ask("fresh-logging", "fresh_logging-9.9.9-py3-none-any.whl"));
    expect(json.files[0].error).toBe("wardby_origin_file_unknown");
    expect(json.files[0].url).toBeUndefined();
  });

  it("refuses a file the run could not be served, such as one newer than the release-age limit", async () => {
    const { origins } = setup({
      index: {
        ...index,
        "fresh-logging": [
          { filename: WHEEL, url: `../../fresh_logging/2.3.21/${WHEEL}`, uploaded: NEW },
          ...index["fresh-logging"].slice(1),
        ],
      },
    });
    // Age is judged per file against the run's policy (the default minimum age is above one day).
    const { json } = await origins(ask("fresh-logging", WHEEL));
    expect(json.files[0].error).toBe("wardby_origin_file_unknown");
  });

  it("gives each item its own error and still answers the others", async () => {
    const { origins } = setup({ index });
    const { json } = await origins({
      files: [
        { name: "fresh-logging", filename: WHEEL },
        { name: "not a name!", filename: "x.whl" },
        { name: "stranger", filename: "stranger-1-py3-none-any.whl" },
      ],
    });
    expect(json.files.map((file: { error?: string }) => file.error ?? "ok")).toEqual([
      "ok",
      "wardby_origin_name_invalid",
      "wardby_origin_not_allowed",
    ]);
  });

  it("reports an unreachable index as a retryable per-item error", async () => {
    const { origins, upstream } = setup({ index });
    upstream.mockImplementation(async () => new Response("down", { status: 503 }));
    const { status, json } = await origins(ask("fresh-logging", WHEEL));
    expect(status).toBe(200);
    expect(json.files[0].error).toBe("wardby_origin_unavailable");
  });

  it("needs a live run's registry token", async () => {
    const { origins } = setup({ index });
    expect((await origins(ask("fresh-logging", WHEEL), "rrg_wrong")).status).toBe(401);
    expect((await origins(ask("fresh-logging", WHEEL), "")).status).toBe(401);
  });

  it("is a PyPI route: other ecosystems and unknown ones are not found", async () => {
    const { origins } = setup({ index });
    expect((await origins(ask("fresh-logging", WHEEL), SECRET_TOKEN, "nope")).status).toBe(404);
  });

  it("answers an empty list with the index alone", async () => {
    const { origins } = setup({ index });
    const { status, json } = await origins({ files: [] });
    expect(status).toBe(200);
    expect(json).toEqual({ index: JFROG_INDEX, files: [] });
  });

  it.each([
    ["not json", "{"],
    ["no files", {}],
    ["files not a list", { files: "x" }],
    ["an item without a filename", { files: [{ name: "requests" }] }],
    ["a filename with a path", { files: [{ name: "requests", filename: "../x.whl" }] }],
    ["a name that is not a string", { files: [{ name: 1, filename: "x.whl" }] }],
    [
      "more files than allowed",
      { files: Array.from({ length: MAX_ORIGIN_FILES + 1 }, () => ({ name: "requests", filename: "x.whl" })) },
    ],
    [
      "more projects than allowed",
      { files: Array.from({ length: 300 }, (_, i) => ({ name: `project-${i}`, filename: "x.whl" })) },
    ],
  ])("rejects a malformed or oversized request: %s", async (_label, body) => {
    const { origins, upstream } = setup({ index });
    const { status, json } = await origins(body);
    expect(status).toBe(400);
    expect(String(json.error)).toMatch(/^wardby_bad_request/);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("never lets a credential reach an answer, an error or a log", async () => {
    log.info.mockClear();
    log.warn.mockClear();
    log.error.mockClear();
    const { origins } = setup({
      index: {
        "fresh-logging": [
          { filename: WHEEL, url: `https://user:${SECRET_UPSTREAM}@artifacts.example.test/art/f/${WHEEL}` },
          {
            filename: "fresh_logging-2.3.23-py3-none-any.whl",
            url: `../../f/fresh_logging-2.3.23-py3-none-any.whl?token=${SECRET_UPSTREAM}`,
          },
          {
            filename: "fresh_logging-2.3.24-py3-none-any.whl",
            url: `https://elsewhere.example.test/f/fresh_logging-2.3.24-py3-none-any.whl`,
          },
          {
            filename: "fresh_logging-2.3.25-py3-none-any.whl",
            url: `../../f/fresh_logging-2.3.25-py3-none-any.whl#sha256=${SECRET_UPSTREAM}`,
          },
        ],
      },
    });
    const { text, json } = await origins({
      files: [
        { name: "fresh-logging", filename: WHEEL },
        { name: "fresh-logging", filename: "fresh_logging-2.3.23-py3-none-any.whl" },
        { name: "fresh-logging", filename: "fresh_logging-2.3.24-py3-none-any.whl" },
        { name: "fresh-logging", filename: "fresh_logging-2.3.25-py3-none-any.whl" },
      ],
    });
    expect(json.files.map((file: { error?: string }) => file.error ?? "ok")).toEqual([
      "wardby_origin_url_unsafe",
      "wardby_origin_url_unsafe",
      "wardby_origin_url_unsafe",
      "ok",
    ]);
    // A fragment is dropped, not echoed.
    expect(json.files[3].url).toBe(
      "https://artifacts.example.test/art/api/pypi/pypi/f/fresh_logging-2.3.25-py3-none-any.whl",
    );
    const everything = JSON.stringify([text, log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]);
    expect(everything).not.toContain(SECRET_UPSTREAM);
    expect(everything).not.toContain(SECRET_TOKEN);
  });

  it("does not echo the token or an upstream failure's detail when the store fails", async () => {
    log.error.mockClear();
    const { origins, store } = setup({ index });
    store.findAllowance = async () => {
      throw new Error(`permission denied for table x ${SECRET_UPSTREAM}`);
    };
    // A root is matched before the store; ask for a dependency name so the store is read.
    const { status, text } = await origins(ask("dependency", "dependency-1-py3-none-any.whl"));
    expect(status).toBe(200);
    expect(text).not.toContain(SECRET_UPSTREAM);
    expect(text).not.toContain("permission denied");
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(SECRET_TOKEN);
  });
});

describe("the origins route, public index", () => {
  it("answers the real files.pythonhosted.org address and https://pypi.org/simple", async () => {
    const url = "https://files.pythonhosted.org/packages/ab/cd/ef0123/requests-2.32.3-py3-none-any.whl";
    const { origins } = setup({
      jfrog: false,
      index: { requests: [{ filename: "requests-2.32.3-py3-none-any.whl", url }] },
    });
    const { json } = await origins(ask("requests", "requests-2.32.3-py3-none-any.whl"));
    expect(json).toEqual({
      index: "https://pypi.org/simple",
      files: [{ name: "requests", filename: "requests-2.32.3-py3-none-any.whl", url }],
    });
  });

  it("answers a package another package's wheel brought in (an allowance), not only allowlisted roots", async () => {
    const url = "https://files.pythonhosted.org/packages/ab/cd/ef0123/idna-3.7-py3-none-any.whl";
    const { origins, store } = setup({
      jfrog: false,
      index: { idna: [{ filename: "idna-3.7-py3-none-any.whl", url }] },
    });
    expect((await origins(ask("idna", "idna-3.7-py3-none-any.whl"))).json.files[0].error).toBe(
      "wardby_origin_not_allowed",
    );
    await store.addAllowances("run-1", "pypi", ["idna"]);
    expect((await origins(ask("idna", "idna-3.7-py3-none-any.whl"))).json.files[0].url).toBe(url);
  });
});
