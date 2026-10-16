import { describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../../../core/logger.js", () => ({ logger: { child: () => log } }));

const { npmAdapter } = await import("../../../coding/registry/npm.js");
const { RegistryError } = await import("../../../coding/registry/types.js");
const { RegistryService } = await import("./service.js");
const { MemoryRegistryStore } = await import("./store.js");
const { capabilityHash } = await import("../proxy.js");

function registryWith(store: InstanceType<typeof MemoryRegistryStore>) {
  return new RegistryService({
    adapters: new Map([["npm", npmAdapter]]),
    store,
    audit: { audit: async () => ({ withheld: () => [], waived: () => [], reported: () => [] }) },
    upstream: async () => new Response("{}"),
    proxyBase: "http://wardby-proxy:8787/registry/",
    limits: { maxFileBytes: 1, maxTotalBytes: 1, maxFiles: 1, idleTimeoutMs: 1_000 },
  });
}

const request = {
  method: "GET",
  ecosystem: "npm",
  subpath: "react",
  token: "rrg_x",
  signal: new AbortController().signal,
};

describe("RegistryService failure logging", () => {
  it("logs an unexpected failure (e.g. a database role missing its grants) while the worker still gets only a 502", async () => {
    log.error.mockClear();
    const store = new MemoryRegistryStore();
    store.findRunByRegistryTokenHash = async () => {
      throw new Error('permission denied for table "RegistryPlanRefusal"');
    };
    const response = await registryWith(store).handle(request);

    expect(response).toMatchObject({ status: 502 });
    expect("body" in response && response.body).not.toContain("permission denied");
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "registry.failed", route: "handle", ecosystem: "npm", err: expect.any(Error) }),
      expect.any(String),
    );
  });

  it("logs a 5xx registry answer as a warning, and leaves ordinary refusals unlogged", async () => {
    log.warn.mockClear();
    const unavailable = new MemoryRegistryStore();
    unavailable.findRunByRegistryTokenHash = async () => {
      throw new RegistryError(503, "wardby_audit_unavailable", "OSV is unreachable");
    };
    await registryWith(unavailable).handle(request);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "registry.unavailable", status: 503, code: "wardby_audit_unavailable" }),
      expect.any(String),
    );

    log.warn.mockClear();
    log.error.mockClear();
    const response = await registryWith(new MemoryRegistryStore()).handle(request);
    expect(response).toMatchObject({ status: 401 });
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("does not log a pending refusal as registry.unavailable", async () => {
    log.warn.mockClear();
    log.error.mockClear();
    const store = new MemoryRegistryStore();
    store.contexts.set(capabilityHash("rrg_x"), {
      runId: "run-1",
      deadlineAt: new Date(Date.now() + 86_400_000),
      allowlist: { npm: ["app"] },
      policy: {},
      repository: "owner/repo",
      cacheImage: null,
      dependencyCache: false,
      packageAudit: null,
    });
    // The root's metadata never arrives, so the walk times out before it
    // reaches the name: a definite (pending) 403, not an outage.
    const registry = new RegistryService({
      adapters: new Map([["npm", npmAdapter]]),
      store,
      audit: { audit: async () => ({ withheld: () => [], waived: () => [], reported: () => [] }) },
      upstream: (_url, init) =>
        new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error))),
      proxyBase: "http://wardby-proxy:8787/registry/",
      limits: { maxFileBytes: 1, maxTotalBytes: 1, maxFiles: 1, idleTimeoutMs: 1_000 },
      metadataTimeoutMs: 1_000,
      graphTimeoutMs: 20,
    });
    const response = await registry.handle({ ...request, subpath: "stranger/-/stranger-1.0.0.tgz" });
    registry.close();

    expect(response).toMatchObject({ status: 403 });
    expect("body" in response && response.body).toContain("wardby_package_not_allowed_pending");
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("logs registry.graph_walk with walked, queued and end on every walk end", async () => {
    const store = new MemoryRegistryStore();
    store.contexts.set(capabilityHash("rrg_x"), {
      runId: "run-1",
      deadlineAt: new Date(Date.now() + 86_400_000),
      allowlist: { npm: ["app", "hung"] },
      policy: {},
      repository: "owner/repo",
      cacheImage: null,
      dependencyCache: false,
      packageAudit: null,
    });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // app has no versions; hung answers 404, but only once released.
    const registry = new RegistryService({
      adapters: new Map([["npm", npmAdapter]]),
      store,
      audit: { audit: async () => ({ withheld: () => [], waived: () => [], reported: () => [] }) },
      upstream: async (url) => {
        if (url.endsWith("/hung")) await held;
        return url.endsWith("/app") ? Response.json({ name: "app", versions: {} }) : new Response("", { status: 404 });
      },
      proxyBase: "http://wardby-proxy:8787/registry/",
      limits: { maxFileBytes: 1, maxTotalBytes: 1, maxFiles: 1, idleTimeoutMs: 1_000 },
      metadataTimeoutMs: 5_000,
      graphTimeoutMs: 20,
    });
    log.info.mockClear();
    await registry.handle({ ...request, subpath: "stranger/-/stranger-1.0.0.tgz" });
    expect(log.info).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenLastCalledWith(
      expect.objectContaining({
        event: "registry.graph_walk",
        runId: "run-1",
        ecosystem: "npm",
        end: "timeout",
        walked: 0,
        queued: 2,
        queuedEdges: 2,
        loads: expect.any(Number),
        durationMs: expect.any(Number),
      }),
      "coding registry graph walk stopped",
    );
    release();
    await registry.handle({ ...request, subpath: "stranger/-/stranger-1.0.0.tgz" });
    registry.close();
    expect(log.info).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenLastCalledWith(
      expect.objectContaining({ event: "registry.graph_walk", end: "complete", walked: 2, queued: 0, queuedEdges: 0 }),
      "coding registry graph walk stopped",
    );
  });
});

describe("RegistryService package audit mode logging", () => {
  it("logs one registry.audited line per audited download", async () => {
    const { createHash } = await import("node:crypto");
    const tarball = new TextEncoder().encode("stranger bytes");
    const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    const store = new MemoryRegistryStore();
    store.contexts.set(capabilityHash("rrg_x"), {
      runId: "run-1",
      deadlineAt: new Date(Date.now() + 86_400_000),
      allowlist: { npm: ["app"] },
      policy: {},
      repository: "owner/repo",
      cacheImage: null,
      dependencyCache: false,
      packageAudit: "audit",
    });
    const registry = new RegistryService({
      adapters: new Map([["npm", npmAdapter]]),
      store,
      audit: { audit: async () => ({ withheld: () => [], waived: () => [], reported: () => [], audited: () => [] }) },
      upstream: async (url) =>
        url === "https://registry.npmjs.org/stranger"
          ? Response.json({
              name: "stranger",
              time: { "1.0.0": old },
              versions: {
                "1.0.0": {
                  name: "stranger",
                  version: "1.0.0",
                  dist: { tarball: "https://registry.npmjs.org/stranger/-/stranger-1.0.0.tgz", integrity },
                },
              },
            })
          : new Response(tarball),
      proxyBase: "http://wardby-proxy:8787/registry/",
      limits: { maxFileBytes: 1_000_000, maxTotalBytes: 2_000_000, maxFiles: 10, idleTimeoutMs: 1_000 },
    });
    log.info.mockClear();
    const response = await registry.handle({ ...request, subpath: "stranger/-/stranger-1.0.0.tgz" });
    if (!("stream" in response)) throw new Error(`expected a stream, got ${response.status}`);
    await new Response(response.stream).arrayBuffer();
    registry.close();
    const audited = log.info.mock.calls.filter(
      ([fields]) => (fields as { event?: string }).event === "registry.audited",
    );
    expect(audited).toEqual([
      [
        {
          event: "registry.audited",
          runId: "run-1",
          ecosystem: "npm",
          name: "stranger",
          version: "1.0.0",
          sizeBytes: tarball.byteLength,
          relation: "unknown",
          mode: "audit",
          advisories: [],
        },
        expect.any(String),
      ],
    ]);
    // Never a walk in an audit-mode run.
    expect(log.info.mock.calls.some(([fields]) => (fields as { event?: string }).event === "registry.graph_walk")).toBe(
      false,
    );
  });
});
