import { describe, expect, it } from "vitest";
import {
  GEMINI_GUARD_UNSET,
  GEMINI_GUARD_VALUES,
  GEMINI_GUARD_VARIABLES,
  geminiCliEnvironment,
} from "./environment.js";

const CAPABILITY = "rrp_FAKEcapability0123456789";
const agentEnvironment = {
  PATH: "/opt/wardby/bin:/usr/local/bin:/usr/bin:/bin",
  HOME: "/home/wardby",
  TMPDIR: "/workspace/.cache/tmp",
  // A service's testEnv trying to steer the CLI (names wardby does not reserve today).
  GEMINI_SYSTEM_MD: "/workspace/evil.md",
  GEMINI_CLI_TRUST_WORKSPACE: "true",
  GEMINI_CLI_SYSTEM_SETTINGS_PATH: "/workspace/system.json",
  GEMINI_CLI_TRUSTED_FOLDERS_PATH: "/workspace/trusted.json",
  GEMINI_TELEMETRY_ENABLED: "true",
  GEMINI_TELEMETRY_TRACES_ENABLED: "true",
  GEMINI_TELEMETRY_TARGET: "gcp",
  GEMINI_TELEMETRY_OTLP_ENDPOINT: "http://collector.example:4317",
  GEMINI_TELEMETRY_OTLP_PROTOCOL: "http",
  GEMINI_TELEMETRY_OTLP_HEADERS: "x-exfil=1",
  GEMINI_TELEMETRY_LOG_PROMPTS: "true",
  GEMINI_TELEMETRY_OUTFILE: "/workspace/telemetry.log",
  GEMINI_TELEMETRY_USE_COLLECTOR: "true",
  GEMINI_TELEMETRY_USE_CLI_AUTH: "true",
  OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.example:4318",
  OTEL_EXPORTER_OTLP_HEADERS: "x-exfil=1",
  OTEL_SDK_DISABLED: "false",
  GEMINI_API_KEY_AUTH_MECHANISM: "bearer",
  GOOGLE_CLOUD_LOCATION: "us-central1",
  DATABASE_URL: "postgres://app@db/app",
};

function build(overrides: Partial<Parameters<typeof geminiCliEnvironment>[0]> = {}) {
  return geminiCliEnvironment({
    agentEnvironment,
    proxyBaseUrl: "http://wardby-proxy:8787",
    capability: CAPABILITY,
    backend: "ai-studio",
    home: "/home/wardby",
    ...overrides,
  });
}

describe("geminiCliEnvironment", () => {
  it("AI Studio: the capability as GEMINI_API_KEY, the proxy as base URL, the proxy host off the tunnel", () => {
    const env = build({ proxyBaseUrl: "http://wardby-proxy:8787/" });
    expect(env).toMatchObject({
      GEMINI_API_KEY: CAPABILITY,
      GOOGLE_GEMINI_BASE_URL: "http://wardby-proxy:8787",
      GOOGLE_GENAI_USE_VERTEXAI: "false",
      GOOGLE_API_KEY: "",
      GOOGLE_VERTEX_BASE_URL: "",
      WARDBY_GEMINI_AUTH_TYPE: "gemini-api-key",
      NO_PROXY: "localhost,127.0.0.1,::1,wardby-proxy",
      no_proxy: "localhost,127.0.0.1,::1,wardby-proxy",
      HOME: "/home/wardby",
      DATABASE_URL: "postgres://app@db/app",
    });
  });

  it("Vertex express: the capability as GOOGLE_API_KEY, express mode kept", () => {
    const env = build({ backend: "vertex" });
    expect(env).toMatchObject({
      GOOGLE_API_KEY: CAPABILITY,
      GOOGLE_GENAI_USE_VERTEXAI: "true",
      GOOGLE_VERTEX_BASE_URL: "http://wardby-proxy:8787",
      GEMINI_API_KEY: "",
      GOOGLE_GEMINI_BASE_URL: "",
      GOOGLE_CLOUD_LOCATION: "",
      WARDBY_GEMINI_AUTH_TYPE: "vertex-ai",
    });
  });

  it("the auth type follows the backend even when the agent environment names another", () => {
    const steered = { ...agentEnvironment, WARDBY_GEMINI_AUTH_TYPE: "oauth-personal" };
    expect(build({ agentEnvironment: steered }).WARDBY_GEMINI_AUTH_TYPE).toBe("gemini-api-key");
    expect(build({ agentEnvironment: steered, backend: "vertex" }).WARDBY_GEMINI_AUTH_TYPE).toBe("vertex-ai");
  });

  it("sets every guard variable last, so no service value reaches the CLI", () => {
    const env = build({ proxyBaseUrl: "http://p:8787", home: "/h" });
    for (const name of GEMINI_GUARD_VARIABLES) expect(env[name], name).toBe("");
    expect(GEMINI_GUARD_VARIABLES).toEqual(
      expect.arrayContaining([
        "GEMINI_SYSTEM_MD",
        "GEMINI_CLI_CUSTOM_HEADERS",
        "GEMINI_CLI_TRUST_WORKSPACE",
        "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
        "GEMINI_CLI_TRUSTED_FOLDERS_PATH",
        "GEMINI_API_KEY_AUTH_MECHANISM",
      ]),
    );
  });

  it("keeps telemetry off: the 0.70.0 telemetry variables read ahead of settings are fixed off or removed", () => {
    const env = build();
    // Every key 0.70.0's resolveTelemetrySettings reads from the environment (ALLOWED_TELEMETRY_ENV_KEYS).
    const telemetryKeys = [
      "GEMINI_TELEMETRY_ENABLED",
      "GEMINI_TELEMETRY_TRACES_ENABLED",
      "GEMINI_TELEMETRY_TARGET",
      "GEMINI_TELEMETRY_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "GEMINI_TELEMETRY_OTLP_PROTOCOL",
      "GEMINI_TELEMETRY_OTLP_HEADERS",
      "OTEL_EXPORTER_OTLP_HEADERS",
      "GEMINI_TELEMETRY_LOG_PROMPTS",
      "GEMINI_TELEMETRY_OUTFILE",
      "GEMINI_TELEMETRY_USE_COLLECTOR",
      "GEMINI_TELEMETRY_USE_CLI_AUTH",
    ];
    const guarded = new Set<string>([
      ...GEMINI_GUARD_VARIABLES,
      ...Object.keys(GEMINI_GUARD_VALUES),
      ...GEMINI_GUARD_UNSET,
    ]);
    for (const key of telemetryKeys) expect(guarded.has(key), key).toBe(true);
    // Booleans: an empty value would still parse as off, but the explicit value says so.
    for (const key of [
      "GEMINI_TELEMETRY_ENABLED",
      "GEMINI_TELEMETRY_TRACES_ENABLED",
      "GEMINI_TELEMETRY_LOG_PROMPTS",
      "GEMINI_TELEMETRY_USE_COLLECTOR",
      "GEMINI_TELEMETRY_USE_CLI_AUTH",
    ]) {
      expect(env[key], key).toBe("false");
    }
    expect(env.OTEL_SDK_DISABLED).toBe("true");
    // Target and protocol: an empty value is a fatal config error, so they are removed and the
    // system settings' value applies.
    expect(env).not.toHaveProperty("GEMINI_TELEMETRY_TARGET");
    expect(env).not.toHaveProperty("GEMINI_TELEMETRY_OTLP_PROTOCOL");
    for (const key of [
      "GEMINI_TELEMETRY_OTLP_ENDPOINT",
      "OTEL_EXPORTER_OTLP_ENDPOINT",
      "GEMINI_TELEMETRY_OTLP_HEADERS",
      "OTEL_EXPORTER_OTLP_HEADERS",
      "GEMINI_TELEMETRY_OUTFILE",
    ]) {
      expect(env[key], key).toBe("");
    }
  });

  it("the guard lists do not overlap and never touch the backend's own variables", () => {
    const all = [...GEMINI_GUARD_VARIABLES, ...Object.keys(GEMINI_GUARD_VALUES), ...GEMINI_GUARD_UNSET];
    expect(new Set(all).size).toBe(all.length);
    for (const name of [
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_GEMINI_BASE_URL",
      "GOOGLE_VERTEX_BASE_URL",
      "GOOGLE_GENAI_USE_VERTEXAI",
      "WARDBY_GEMINI_AUTH_TYPE",
      "HOME",
      "NO_PROXY",
    ]) {
      expect(all, name).not.toContain(name);
    }
  });

  it("keeps the tunnel's NO_PROXY and adds the MCP token only outside header mode", () => {
    const tunnel = {
      ...agentEnvironment,
      NO_PROXY: "localhost,127.0.0.1,::1,wardby-proxy",
      HTTPS_PROXY: "http://run:t@wardby-proxy:8788",
    };
    const env = build({ agentEnvironment: tunnel, home: "/h", mcpToken: "rmt_FAKEmcp0123456789abcdef" });
    expect(env.HTTPS_PROXY).toBe("http://run:t@wardby-proxy:8788");
    expect(env.WARDBY_MCP_TOKEN).toBe("rmt_FAKEmcp0123456789abcdef");
    const header = build({
      proxyBaseUrl: "http://p:8787",
      home: "/h",
      mcpToken: "rmt_placeholder_injected_by_gateway",
      mcpHeaderMode: true,
    });
    expect(header.WARDBY_MCP_TOKEN).toBeUndefined();
  });

  it("the capability appears only in the backend's key variable", () => {
    for (const backend of ["ai-studio", "vertex"] as const) {
      const env = build({ backend });
      const holders = Object.entries(env)
        .filter(([, value]) => value.includes(CAPABILITY))
        .map(([name]) => name);
      expect(holders).toEqual([backend === "vertex" ? "GOOGLE_API_KEY" : "GEMINI_API_KEY"]);
    }
  });
});
