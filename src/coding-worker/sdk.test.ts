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

  describe("with MCP tools (the run's MCP token is set)", () => {
    const TOKEN = "rmt_fake_token_for_codex_sdk_options_test_0001";

    it("adds the wardby_mcp server, reading its bearer from WARDBY_MCP_TOKEN", () => {
      const options = codexSdkOptions({ ...baseConfig, mcpToken: TOKEN });
      expect((options.config as Record<string, unknown>).mcp_servers).toEqual({
        wardby_mcp: {
          url: "http://proxy:8080/mcp",
          bearer_token_env_var: "WARDBY_MCP_TOKEN",
          tool_timeout_sec: 300,
          default_tools_approval_mode: "approve",
        },
      });
    });

    it("puts the token in the Codex process env only, never in the shell's env or the config", () => {
      const options = codexSdkOptions({ ...baseConfig, mcpToken: TOKEN });
      expect(options.env).toEqual({ ...baseConfig.environment, WARDBY_MCP_TOKEN: TOKEN });
      expect(options.config.shell_environment_policy.set).toEqual(baseConfig.environment);
      expect(JSON.stringify(options.config)).not.toContain(TOKEN);
      expect(baseConfig.environment).not.toHaveProperty("WARDBY_MCP_TOKEN");
    });

    it("is unchanged without MCP tools", () => {
      const options = codexSdkOptions(baseConfig);
      expect(options.config).not.toHaveProperty("mcp_servers");
      expect(options.env).toBe(baseConfig.environment);
      expect(JSON.stringify(options)).not.toContain("wardby_mcp");
    });
  });
});
