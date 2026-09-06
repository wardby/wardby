import { describe, it, expect } from "vitest";
import { loadProviderConfig, loadMcpConfig } from "./providers.js";

describe("provider config", () => {
  it("accepts anthropic and bedrock as llm kinds", () => {
    expect(loadProviderConfig({ LLM_PROVIDER: "anthropic" } as NodeJS.ProcessEnv).llm).toBe("anthropic");
    expect(loadProviderConfig({ LLM_PROVIDER: "bedrock" } as NodeJS.ProcessEnv).llm).toBe("bedrock");
  });

  it("defaults auth to delegating", () => {
    expect(loadProviderConfig({} as NodeJS.ProcessEnv).auth).toBe("delegating");
  });

  it("accepts self-hosted as an auth kind", () => {
    expect(loadProviderConfig({ AUTH_PROVIDER: "self-hosted" } as NodeJS.ProcessEnv).auth).toBe("self-hosted");
  });
});

describe("loadMcpConfig", () => {
  it("defaults to stdio + delegating with loopback bind", () => {
    const c = loadMcpConfig({} as NodeJS.ProcessEnv);
    expect(c.transport).toBe("stdio");
    expect(c.canonicalUri).toBeUndefined();
    expect(c.localPrincipal).toBe("local");
  });

  it("reads http + canonical uri + audience", () => {
    const c = loadMcpConfig({
      MCP_TRANSPORT: "http",
      MCP_HTTP_BIND: "127.0.0.1:8080",
      MCP_CANONICAL_URI: "https://host/mcp",
    } as NodeJS.ProcessEnv);
    expect(c.transport).toBe("http");
    expect(c.httpBind).toEqual({ host: "127.0.0.1", port: 8080 });
    expect(c.canonicalUri).toBe("https://host/mcp");
  });
});
