import { describe, expect, it } from "vitest";
import { codexSdkOptions } from "./sdk.js";

const baseConfig = {
  proxyBaseUrl: "http://proxy:8080/",
  capability: "rrp_worker_capability",
  developerInstructions: "trusted instructions",
  environment: { HOME: "/home/wardby", LANG: "C.UTF-8", PATH: "/usr/local/bin:/usr/bin:/bin", TMPDIR: "/tmp" },
  disabledSkills: ["imagegen", "openai-docs", "skill-creator", "skill-installer"],
};

describe("codexSdkOptions", () => {
  it("keeps the proxy capability out of agent shell environments", () => {
    const environment = baseConfig.environment;
    const options = codexSdkOptions({ ...baseConfig, environment });

    expect(options.apiKey).toBe("rrp_worker_capability");
    expect(options.config.model_providers.wardby_proxy.base_url).toBe("http://proxy:8080/v1");
    expect(options.config.shell_environment_policy).toEqual({
      inherit: "none",
      ignore_default_excludes: false,
      set: environment,
    });
    expect(JSON.stringify(options.config.shell_environment_policy)).not.toContain("rrp_worker_capability");
  });

  it("retries a failed model request or a dropped stream a few times instead of failing the run", () => {
    const provider = codexSdkOptions({ ...baseConfig, environment: {} }).config.model_providers.wardby_proxy;
    expect(provider.request_max_retries).toBe(3);
    expect(provider.stream_max_retries).toBe(3);
  });

  it("passes Codex one disabled entry per skill name", () => {
    const options = codexSdkOptions({ ...baseConfig, disabledSkills: ["alpha", "imagegen"] });
    expect(options.config.skills).toEqual({
      config: [
        { name: "alpha", enabled: false },
        { name: "imagegen", enabled: false },
      ],
    });
  });
});
