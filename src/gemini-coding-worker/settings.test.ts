import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CLAUDE_COMMAND_TIMEOUT_MS,
  MAX_CLAUDE_COMMAND_TIMEOUT_MS,
  MIN_CLAUDE_COMMAND_TIMEOUT_MS,
} from "../coding/command-timeouts.js";
import { GEMINI_BUILTIN_AGENTS, GEMINI_HELPER_ALIASES } from "./cli.js";
import {
  DEFAULT_COMMAND_TIMEOUT_MS,
  geminiUserSettings,
  MAX_COMMAND_TIMEOUT_MS,
  MIN_COMMAND_TIMEOUT_MS,
  readGeminiRunSettings,
  repoAgentNames,
  writeGeminiUserSettings,
  type GeminiUserSettingsInput,
} from "./settings.js";

const base: GeminiUserSettingsInput = {
  backend: "ai-studio",
  googleModel: "gemini-4-neon",
  maxOutputTokens: 32_000,
  maxSessionTurns: 200,
  commandTimeoutMs: 600_000,
  subAgents: true,
  webTools: "off",
  repoSkills: true,
  repoAgentNames: [],
  outputSchema: { type: "object" },
};
type Override = {
  match: Record<string, string>;
  modelConfig: { model?: string; generateContentConfig?: Record<string, unknown> };
};
const overrides = (settings: Record<string, unknown>) =>
  (settings.modelConfigs as { customOverrides: Override[] }).customOverrides;

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("readGeminiRunSettings", () => {
  it("defaults: sub-agents on, web tools off, the shared command timeout", () => {
    expect(readGeminiRunSettings({})).toEqual({ subAgents: true, webTools: "off", commandTimeoutMs: 600_000 });
    expect([DEFAULT_COMMAND_TIMEOUT_MS, MIN_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS]).toEqual([
      DEFAULT_CLAUDE_COMMAND_TIMEOUT_MS,
      MIN_CLAUDE_COMMAND_TIMEOUT_MS,
      MAX_CLAUDE_COMMAND_TIMEOUT_MS,
    ]);
  });
  it("reads the launcher's values and refuses anything else", () => {
    expect(
      readGeminiRunSettings({
        WARDBY_SUB_AGENTS: "false",
        WARDBY_WEB_TOOLS: "search",
        WARDBY_COMMAND_TIMEOUT_MS: "90000",
      }),
    ).toEqual({ subAgents: false, webTools: "search", commandTimeoutMs: 90_000 });
    for (const env of [
      { WARDBY_SUB_AGENTS: "yes" },
      { WARDBY_WEB_TOOLS: "all" },
      { WARDBY_COMMAND_TIMEOUT_MS: "999" },
      { WARDBY_COMMAND_TIMEOUT_MS: "7200001" },
      { WARDBY_COMMAND_TIMEOUT_MS: "1.5e4" },
    ]) {
      expect(() => readGeminiRunSettings(env)).toThrow("worker_run_settings_invalid");
    }
  });
});

describe("geminiUserSettings", () => {
  it("caps every model reply: the run model, all 22 helper aliases (moved to the run model), every agent", () => {
    const settings = geminiUserSettings({ ...base, repoAgentNames: ["reviewer"] });
    const list = overrides(settings);
    expect(list[0]).toEqual({
      match: { model: "gemini-4-neon" },
      modelConfig: { generateContentConfig: { maxOutputTokens: 32_000 } },
    });
    for (const alias of GEMINI_HELPER_ALIASES) {
      expect(list).toContainEqual({
        match: { model: alias },
        modelConfig: { model: "gemini-4-neon", generateContentConfig: { maxOutputTokens: 32_000 } },
      });
    }
    expect((settings.agents as { overrides: Record<string, unknown> }).overrides).toEqual(
      Object.fromEntries(
        [...GEMINI_BUILTIN_AGENTS, "reviewer"].map((name) => [name, { modelConfig: { model: "gemini-4-neon" } }]),
      ),
    );
  });

  it("sets the final-answer schema on the run model's own replies only", () => {
    const last = overrides(geminiUserSettings(base)).at(-1)!;
    expect(last).toEqual({
      match: { model: "gemini-4-neon", overrideScope: "core" },
      modelConfig: {
        generateContentConfig: { responseMimeType: "application/json", responseJsonSchema: { type: "object" } },
      },
    });
  });

  it("maps the run's limits, auth and skills", () => {
    const settings = geminiUserSettings({
      ...base,
      backend: "vertex",
      maxSessionTurns: 7,
      commandTimeoutMs: 90_500,
      repoSkills: false,
    });
    expect(settings).toMatchObject({
      security: { auth: { selectedType: "vertex-ai" } },
      model: { maxSessionTurns: 7 },
      tools: { shell: { inactivityTimeout: 91 } },
      skills: { enabled: false },
    });
    expect(geminiUserSettings(base).skills).toEqual({
      enabled: true,
      disabled: ["skill-creator", "antigravity-support"],
    });
    expect(geminiUserSettings(base).security).toEqual({ auth: { selectedType: "gemini-api-key" } });
  });

  it("excludes invoke_agent and the web tools per run (they union with the system file's)", () => {
    const exclude = (input: Partial<GeminiUserSettingsInput>) =>
      (geminiUserSettings({ ...base, ...input }).tools as { exclude: string[] }).exclude;
    expect(exclude({})).toEqual(["google_web_search", "web_fetch"]);
    expect(exclude({ subAgents: false })).toEqual(["invoke_agent", "google_web_search", "web_fetch"]);
    expect(exclude({ webTools: "search" })).toEqual(["web_fetch"]);
    expect(exclude({ webTools: "search-and-fetch" })).toEqual([]);
  });

  it("adds the wardby_mcp server only on a run with MCP tools, never with the token's value", () => {
    expect(geminiUserSettings(base).mcpServers).toBeUndefined();
    expect(
      geminiUserSettings({ ...base, mcp: { proxyBaseUrl: "http://wardby-proxy:8787/", headerMode: false } }).mcpServers,
    ).toEqual({
      wardby_mcp: {
        httpUrl: "http://wardby-proxy:8787/mcp",
        headers: { Authorization: "Bearer $WARDBY_MCP_TOKEN" },
        timeout: 300_000,
        trust: true,
      },
    });
    expect(
      (
        geminiUserSettings({ ...base, mcp: { proxyBaseUrl: "http://p:8787", headerMode: true } }).mcpServers as Record<
          string,
          { headers: unknown }
        >
      ).wardby_mcp.headers,
    ).toEqual({ "x-wardby-mcp-token": "rmt_placeholder_injected_by_gateway" });
  });
});

describe("writeGeminiUserSettings and repoAgentNames", () => {
  it("writes ~/.gemini/settings.json readable by the worker only", async () => {
    root = await mkdtemp(join(tmpdir(), "wardby-gemini-home-"));
    const path = await writeGeminiUserSettings(root, { model: { maxSessionTurns: 1 } });
    expect(path).toBe(join(root, ".gemini", "settings.json"));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ model: { maxSessionTurns: 1 } });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, ".gemini"))).mode & 0o777).toBe(0o700);
  });

  it("rewrites the file whole on a second call, through an agent's replaced link or loosened modes", async () => {
    root = await mkdtemp(join(tmpdir(), "wardby-gemini-home-"));
    const path = await writeGeminiUserSettings(root, { model: { maxSessionTurns: 1 }, mcpServers: { x: {} } });
    // What a run's agent could leave behind before the repair turn.
    const outside = join(root, "outside.json");
    await writeFile(outside, "{}");
    await rm(path);
    await symlink(outside, path);
    await chmod(join(root, ".gemini"), 0o777);
    expect(await writeGeminiUserSettings(root, { model: { maxSessionTurns: 2 } })).toBe(path);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ model: { maxSessionTurns: 2 } });
    expect((await lstat(path)).isSymbolicLink()).toBe(false);
    expect(await readFile(outside, "utf8")).toBe("{}");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, ".gemini"))).mode & 0o777).toBe(0o700);
  });

  it("replaces a ~/.gemini that is not a real directory", async () => {
    root = await mkdtemp(join(tmpdir(), "wardby-gemini-home-"));
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, join(root, ".gemini"));
    const path = await writeGeminiUserSettings(root, { a: 1 });
    expect((await lstat(join(root, ".gemini"))).isDirectory()).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ a: 1 });
    await expect(readFile(join(elsewhere, "settings.json"))).rejects.toThrow();
  });

  it("reads a repo's local agent names from frontmatter, bounded and without following links", async () => {
    root = await mkdtemp(join(tmpdir(), "wardby-gemini-agents-"));
    const agents = join(root, ".gemini", "agents");
    await mkdir(agents, { recursive: true });
    await writeFile(join(agents, "reviewer.md"), "---\nname: reviewer\ndescription: x\n---\nbody");
    await writeFile(join(agents, "no-name.md"), "---\ndescription: x\n---\n");
    await writeFile(join(agents, "bad.md"), "---\nname: not a valid name!\n---\n");
    await writeFile(join(agents, "notes.txt"), "---\nname: ignored\n---\n");
    await symlink("/etc/passwd", join(agents, "link.md"));
    expect(await repoAgentNames(root)).toEqual(["no-name", "reviewer"]);
    expect(await repoAgentNames(join(root, "missing"))).toEqual([]);
  });
});
