import { describe, it, expect } from "vitest";
import { loadProviderConfig, loadMcpConfig, loadGitHubVcsConfig } from "./providers.js";

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

  it("defaults VCS to GitHub", () => {
    expect(loadProviderConfig({} as NodeJS.ProcessEnv).vcs).toBe("github");
  });
});

describe("loadGitHubVcsConfig", () => {
  it("loads credentials, workspace, API, and positive limits", () => {
    expect(loadGitHubVcsConfig({
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "private-key",
      VCS_WORK_ROOT: "/var/lib/reevo-vcs",
      GITHUB_API_VERSION: "2026-03-10",
      VCS_MAX_CHANGED_FILES: "50",
      VCS_MAX_DIFF_BYTES: "4096",
    } as NodeJS.ProcessEnv)).toEqual({
      appId: "123",
      privateKey: "private-key",
      workRoot: "/var/lib/reevo-vcs",
      apiVersion: "2026-03-10",
      maxChangedFiles: 50,
      maxDiffBytes: 4096,
    });
  });

  it.each(["0", "-1", "1.5", "nope"])("rejects invalid VCS limits (%s)", (value) => {
    expect(() => loadGitHubVcsConfig({ VCS_MAX_DIFF_BYTES: value } as NodeJS.ProcessEnv)).toThrow(
      "VCS_MAX_DIFF_BYTES must be a positive integer",
    );
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

  it("defaults secretElicitationProtocol to off, and reads it on when explicitly set", () => {
    expect(loadMcpConfig({} as NodeJS.ProcessEnv).secretElicitationProtocol).toBe(false);
    expect(loadMcpConfig({ MCP_SECRET_ELICITATION_PROTOCOL: "true" } as NodeJS.ProcessEnv).secretElicitationProtocol).toBe(true);
  });
});
