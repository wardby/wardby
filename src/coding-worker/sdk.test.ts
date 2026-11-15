import { describe, expect, it } from "vitest";
import { codexSdkOptions, createCodexSdkClient } from "./sdk.js";

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

  it("header mode: the placeholder goes in x-api-key and nothing sets Authorization", () => {
    const options = codexSdkOptions({
      ...baseConfig,
      capability: "rrp_placeholder_injected_by_gateway",
      capabilityHeader: "x-api-key",
    });
    expect("apiKey" in options).toBe(false);
    const provider = options.config.model_providers.wardby_proxy;
    expect("env_key" in provider).toBe(false);
    expect("http_headers" in provider && provider.http_headers).toEqual({
      "x-api-key": "rrp_placeholder_injected_by_gateway",
    });
    expect(JSON.stringify(options.config.shell_environment_policy)).not.toContain("rrp_placeholder");
  });

  it("header mode refuses any capability but the gateway's placeholder, naming no value", () => {
    const real = `rrp_${"R".repeat(43)}`;
    for (const capability of [real, "rrp_worker_capability", ""]) {
      let error: unknown;
      try {
        codexSdkOptions({ ...baseConfig, capability, capabilityHeader: "x-api-key" });
      } catch (caught) {
        error = caught;
      }
      expect((error as Error).message).toBe("worker_capability_header_needs_placeholder");
      if (capability) expect(String(error)).not.toContain(capability);
    }
    // The client factory builds the same options first, so a real capability never reaches Codex's argv.
    expect(() => createCodexSdkClient({ ...baseConfig, capability: real, capabilityHeader: "x-api-key" })).toThrow(
      "worker_capability_header_needs_placeholder",
    );
  });

  it("without header mode the options are exactly today's", () => {
    const options = codexSdkOptions(baseConfig);
    expect(options).toEqual({
      apiKey: "rrp_worker_capability",
      env: baseConfig.environment,
      config: {
        developer_instructions: "trusted instructions",
        skills: { config: baseConfig.disabledSkills.map((name) => ({ name, enabled: false })) },
        shell_environment_policy: { inherit: "none", ignore_default_excludes: false, set: baseConfig.environment },
        model_provider: "wardby_proxy",
        model_providers: {
          wardby_proxy: {
            name: "Wardby per-run proxy",
            base_url: "http://proxy:8080/v1",
            env_key: "CODEX_API_KEY",
            wire_api: "responses",
            request_max_retries: 3,
            stream_max_retries: 3,
            supports_websockets: false,
          },
        },
      },
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

    // Task 1A outcome A: Codex sends http_headers and no Authorization when bearer_token_env_var is unset.
    it("header mode: the placeholder goes in http_headers", () => {
      const options = codexSdkOptions({
        ...baseConfig,
        mcpToken: "rmt_placeholder_injected_by_gateway",
        mcpTokenHeader: "x-wardby-mcp-token",
      });
      expect((options.config as Record<string, unknown>).mcp_servers).toEqual({
        wardby_mcp: {
          url: "http://proxy:8080/mcp",
          http_headers: { "x-wardby-mcp-token": "rmt_placeholder_injected_by_gateway" },
          tool_timeout_sec: 300,
          default_tools_approval_mode: "approve",
        },
      });
      expect(options.env).toEqual(baseConfig.environment);
      expect(options.env).not.toHaveProperty("WARDBY_MCP_TOKEN");
    });

    it("header mode refuses a real token", () => {
      const real = "rmt_" + "A".repeat(43);
      let error: unknown;
      try {
        codexSdkOptions({ ...baseConfig, mcpToken: real, mcpTokenHeader: "x-wardby-mcp-token" });
      } catch (caught) {
        error = caught;
      }
      expect((error as Error).message).toBe("worker_mcp_header_needs_placeholder");
      expect(String(error)).not.toContain(real);
      expect(() =>
        createCodexSdkClient({ ...baseConfig, mcpToken: real, mcpTokenHeader: "x-wardby-mcp-token" }),
      ).toThrow("worker_mcp_header_needs_placeholder");
    });

    it("header mode with the capability header too: nothing sets Authorization", () => {
      const options = codexSdkOptions({
        ...baseConfig,
        capability: "rrp_placeholder_injected_by_gateway",
        capabilityHeader: "x-api-key",
        mcpToken: "rmt_placeholder_injected_by_gateway",
        mcpTokenHeader: "x-wardby-mcp-token",
      });
      const serialized = JSON.stringify(options);
      expect(serialized).not.toContain('"env_key"');
      expect(serialized).not.toContain('"bearer_token_env_var"');
      expect("apiKey" in options).toBe(false);
    });

    it("is unchanged without MCP tools", () => {
      const options = codexSdkOptions(baseConfig);
      expect(options.config).not.toHaveProperty("mcp_servers");
      expect(options.env).toBe(baseConfig.environment);
      expect(JSON.stringify(options)).not.toContain("wardby_mcp");
    });
  });
});
