import { describe, expect, it } from "vitest";
import { codexSdkOptions } from "./sdk.js";

describe("codexSdkOptions", () => {
  it("keeps the proxy capability out of agent shell environments", () => {
    const environment = { HOME: "/home/wardby", LANG: "C.UTF-8", PATH: "/usr/local/bin:/usr/bin:/bin", TMPDIR: "/tmp" };
    const options = codexSdkOptions({
      proxyBaseUrl: "http://proxy:8080/",
      capability: "rrp_worker_capability",
      developerInstructions: "trusted instructions",
      environment,
    });

    expect(options.apiKey).toBe("rrp_worker_capability");
    expect(options.config.model_providers.wardby_proxy.base_url).toBe("http://proxy:8080/v1");
    expect(options.config.shell_environment_policy).toEqual({
      inherit: "none",
      ignore_default_excludes: false,
      set: environment,
    });
    expect(JSON.stringify(options.config.shell_environment_policy)).not.toContain("rrp_worker_capability");
  });
});
