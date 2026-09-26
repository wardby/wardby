import { describe, expect, it } from "vitest";
import { deriveRegistryToken } from "./token.js";
import { registryWorkerSetup } from "./worker-config.js";

describe("registryWorkerSetup", () => {
  it("configures every adapter with the derived token, never the capability", () => {
    const setup = registryWorkerSetup({
      proxyBaseUrl: "http://wardby-proxy:8787",
      capability: "rrp_secret",
      cacheRoot: "/workspace/.cache",
    });
    const token = deriveRegistryToken("rrp_secret");
    expect(token).toMatch(/^rrg_[A-Za-z0-9_-]{43}$/);
    expect(setup.env.npm_config_registry).toBe("http://wardby-proxy:8787/registry/npm/");
    expect(setup.env.PIP_INDEX_URL).toContain(token);
    expect(JSON.stringify(setup)).not.toContain("rrp_secret");
    expect(setup.files.every((file) => file.path.startsWith("/workspace/.cache/"))).toBe(true);
  });
});
