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
  geminiSubAgentsDisabledReason,
  geminiUserSettings,
  MAX_COMMAND_TIMEOUT_MS,
  MIN_COMMAND_TIMEOUT_MS,
  readGeminiRunSettings,
  readRepoAgents,
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
  repoAgentsUnpinnable: false,
  outputSchema: { type: "object" },
};
type Override = {
  match: Record<string, string | boolean>;
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
      match: { model: "gemini-4-neon", isChatModel: true },
      modelConfig: {
        generateContentConfig: { responseMimeType: "application/json", responseJsonSchema: { type: "object" } },
      },
    });
  });

  it("matches the schema to the main loop's chat key, never a helper, when a helper's default is the run model", () => {
    const list = overrides(geminiUserSettings({ ...base, googleModel: "gemini-3-flash-preview" }));
    const withSchema = list.filter((o) => o.modelConfig.generateContentConfig?.responseJsonSchema !== undefined);
    expect(withSchema.map((o) => o.match)).toEqual([{ model: "gemini-3-flash-preview", isChatModel: true }]);
    expect(list.some((o) => "overrideScope" in o.match)).toBe(false);
    for (const alias of GEMINI_HELPER_ALIASES) {
      for (const o of list.filter((x) => x.match.model === alias)) {
        expect(o.modelConfig.generateContentConfig).toEqual({ maxOutputTokens: 32_000 });
      }
    }
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

  it("turns sub-agents off (not the run) when a repository agent cannot be pinned, and says why", () => {
    const unpinnable = { ...base, webTools: "search-and-fetch" as const, repoAgentsUnpinnable: true };
    expect((geminiUserSettings(unpinnable).tools as { exclude: string[] }).exclude).toEqual(["invoke_agent"]);
    expect(geminiSubAgentsDisabledReason(unpinnable)).toBe("repo_agents_unpinnable");
    expect(geminiSubAgentsDisabledReason(base)).toBeUndefined();
    // Already off by the operator: nothing to record.
    expect(geminiSubAgentsDisabledReason({ ...unpinnable, subAgents: false })).toBeUndefined();
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

describe("writeGeminiUserSettings and readRepoAgents", () => {
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

  const agentsDir = async () => {
    root = await mkdtemp(join(tmpdir(), "wardby-gemini-agents-"));
    const agents = join(root, ".gemini", "agents");
    await mkdir(agents, { recursive: true });
    return agents;
  };
  const agent = (name: string) => `---\nname: ${name}\ndescription: x\ntools:\n  - read_file\n---\nbody`;

  it("pins every agent file the CLI loads, skipping what it skips", async () => {
    const agents = await agentsDir();
    await writeFile(join(agents, "reviewer.md"), agent("reviewer"));
    await writeFile(join(agents, "b.md"), agent("helper_2"));
    await writeFile(join(agents, "_draft.md"), "not an agent");
    await writeFile(join(agents, "notes.txt"), "---\nname: ignored\n---\n");
    await symlink("/etc/passwd", join(agents, "link.md"));
    await mkdir(join(agents, "dir.md"));
    expect(await readRepoAgents(root!)).toEqual({ names: ["helper_2", "reviewer"], unpinnable: false });
    expect(await readRepoAgents(join(root!, "missing"))).toEqual({ names: [], unpinnable: false });
  });

  it.each([
    ["no name", "---\ndescription: x\n---\n"],
    ["a non-slug name", "---\nname: not a valid name!\n---\n"],
    ["an upper-case name", "---\nname: Reviewer\n---\n"],
    ["a quoted name", '---\nname: "reviewer"\n---\n'],
    ["a trailing comment", "---\nname: reviewer # main\n---\n"],
    ["two name lines", "---\nname: a\nname: b\n---\n"],
    ["a quoted second key", '---\nname: a\n"n\\u0061me": b\n---\n'],
    ["an indented name", "---\nname: a\nmeta:\n  name: b\n---\n"],
    ["a folded continuation", "---\nname: a\n  b\n---\n"],
    ["a merge key", "---\nname: a\n<<: *base\n---\n"],
    ["a flow mapping", "---\n{name: a}\n---\n"],
    ["the remote-agents list", "---\n- name: a\n  kind: remote\n---\n"],
    ["a BOM", "\uFEFF---\nname: a\n---\n"],
    ["CRLF", "---\r\nname: a\r\n---\r\n"],
    ["trailing spaces on the delimiter", "---  \nname: a\n---\n"],
    ["no closing delimiter", "---\nname: a\n"],
  ])("marks the set unpinnable for %s, keeping the names it is sure of", async (_label, content) => {
    const agents = await agentsDir();
    await writeFile(join(agents, "a-good.md"), agent("good"));
    await writeFile(join(agents, "z-odd.md"), content);
    expect(await readRepoAgents(root!)).toEqual({ names: ["good"], unpinnable: true });
  });

  it("marks the set unpinnable past the size bound", async () => {
    const agents = await agentsDir();
    await writeFile(join(agents, "big.md"), agent("big") + "x".repeat(64 * 1024));
    expect(await readRepoAgents(root!)).toEqual({ names: [], unpinnable: true });
  });

  it("pins the first 64 files in name order and marks the rest unpinnable", async () => {
    const agents = await agentsDir();
    const names = Array.from({ length: 65 }, (_, i) => `agent-${String(i).padStart(2, "0")}`);
    // Written in reverse so the result shows the sort, not the directory's order.
    for (const name of [...names].reverse()) await writeFile(join(agents, `${name}.md`), agent(name));
    expect(await readRepoAgents(root!)).toEqual({ names: names.slice(0, 64), unpinnable: true });
    await rm(join(agents, "agent-64.md"));
    expect(await readRepoAgents(root!)).toEqual({ names: names.slice(0, 64), unpinnable: false });
  });
});
