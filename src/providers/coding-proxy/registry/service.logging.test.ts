import { describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock("../../../core/logger.js", () => ({ logger: { child: () => log } }));

const { npmAdapter } = await import("../../../coding/registry/npm.js");
const { RegistryError } = await import("../../../coding/registry/types.js");
const { RegistryService } = await import("./service.js");
const { MemoryRegistryStore } = await import("./store.js");

function registryWith(store: InstanceType<typeof MemoryRegistryStore>) {
  return new RegistryService({
    adapters: new Map([["npm", npmAdapter]]),
    store,
    audit: { audit: async () => ({ withheld: () => [], reported: () => [] }) },
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
});
