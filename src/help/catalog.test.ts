import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import semver from "semver";
import { buildHelpCatalog } from "./catalog.js";
import { searchHelp } from "./search.js";
import { SERVICE_REFUSAL_CODES, SERVICE_UNREADY_CATEGORY } from "../coding/services/wording.js";
import { PROTECTED_PATH_CATEGORY } from "../coding/protected-path-wording.js";
import { MERGE_CONFLICT_CATEGORY, TARGET_MERGE_CATEGORY } from "../coding/merge-wording.js";

const roots: string[] = [];

async function corpus(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wardby-help-"));
  roots.push(root);
  await Promise.all(
    Object.entries(files).map(async ([path, content]) => {
      const target = join(root, path);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, content, "utf8");
    }),
  );
  return root;
}

function page(fields = "", body = "# Heading\n\nUseful text.\n"): string {
  return `---\nid: getting-started\ntitle: Getting started\nsummary: Start Wardby safely.\naudience: operator\ntags: [setup, operator]\nappliesTo: >=0.2.1\n${fields}---\n${body}`;
}

function versionedPage(id: string, appliesTo: string, body = `# ${id}\n`): string {
  return `---\nid: ${id}\ntitle: ${id}\nsummary: ${id} help.\naudience: operator\ntags: [setup]\nappliesTo: ${appliesTo}\n---\n${body}`;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("buildHelpCatalog", () => {
  it("builds a stable catalog with searchable text and headings", async () => {
    const root = await corpus({
      "getting-started.md": page(
        "",
        "# Start here\n\nRun [the guide](#start-here).\n\n`wardby doctor` verifies the setup.\n",
      ),
    });

    await expect(buildHelpCatalog(root)).resolves.toEqual({
      schemaVersion: 1,
      pages: [
        expect.objectContaining({
          id: "getting-started",
          sourcePath: "getting-started.md",
          headings: [{ level: 1, text: "Start here", slug: "start-here" }],
          plainText: "Start here Run the guide. wardby doctor verifies the setup.",
        }),
      ],
    });
  });

  it("rejects duplicate ids and invalid internal links", async () => {
    const duplicate = await corpus({ "a.md": page(), "b.md": page("", "# Another\n") });
    await expect(buildHelpCatalog(duplicate)).rejects.toThrow('duplicate page id "getting-started"');

    const badLink = await corpus({ "getting-started.md": page("", "# Heading\n\n[Missing](missing.md)\n") });
    await expect(buildHelpCatalog(badLink)).rejects.toThrow('unknown help link "missing.md"');
  });

  it("rejects unknown metadata and missing required fields", async () => {
    const unknownField = await corpus({ "getting-started.md": page("owner: platform\n") });
    await expect(buildHelpCatalog(unknownField)).rejects.toThrow('unknown frontmatter field "owner"');

    const missingField = await corpus({
      "getting-started.md":
        "---\nid: getting-started\ntitle: Getting started\nsummary: Start Wardby safely.\naudience: operator\ntags: [setup]\n---\n# Heading\n",
    });
    await expect(buildHelpCatalog(missingField)).rejects.toThrow('missing frontmatter field "appliesTo"');
  });

  it("includes only articles available in the target release and normalizes quoted versions", async () => {
    const root = await corpus({
      "current.md": versionedPage("current", ">=0.5.3"),
      "future.md": versionedPage("future", '">=0.6.0"'),
    });

    const current = await buildHelpCatalog(root, "0.5.3");
    expect(current.pages.map((entry) => entry.id)).toEqual(["current"]);
    expect((await buildHelpCatalog(root, "0.6.0")).pages.map((entry) => entry.id)).toEqual(["current", "future"]);
    expect((await buildHelpCatalog(root, "0.6.0")).pages[1].appliesTo).toBe(">=0.6.0");
  });

  it.each(["help://future", "future.md"])(
    "rejects a current article linking to future help through %s",
    async (href) => {
      const root = await corpus({
        "current.md": versionedPage("current", ">=0.5.3", `# current\n\n[Future](${href})\n`),
        "future.md": versionedPage("future", ">=0.6.0"),
      });

      await expect(buildHelpCatalog(root, "0.5.3")).rejects.toThrow(`help link "${href}" requires >=0.6.0`);
      await expect(buildHelpCatalog(root, "0.6.0")).resolves.toHaveProperty("pages", expect.any(Array));
    },
  );

  it("rejects invalid release metadata and target versions", async () => {
    const root = await corpus({ "current.md": versionedPage("current", ">=soon") });
    await expect(buildHelpCatalog(root)).rejects.toThrow("appliesTo must be a minimum release");
    await expect(buildHelpCatalog(root, "latest")).rejects.toThrow('Invalid help release version "latest"');
  });

  it("builds the checked-in corpus with a page for coding services and each of their errors", async () => {
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    const ids = new Set(catalog.pages.map((entry) => entry.id));

    expect(ids).toContain("coding-services");
    for (const code of [
      ...SERVICE_REFUSAL_CODES,
      SERVICE_UNREADY_CATEGORY,
      PROTECTED_PATH_CATEGORY,
      MERGE_CONFLICT_CATEGORY,
      TARGET_MERGE_CATEGORY,
    ]) {
      const id = `errors/${code.replaceAll("_", "-")}`;
      expect(ids, id).toContain(id);
      expect(catalog.pages.find((entry) => entry.id === id)?.markdown).toContain(`\`${code}`);
    }
  });

  it("builds a release-compatible catalog from the checked-in corpus", async () => {
    const version = (
      JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }
    ).version;
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)), version);
    expect(catalog.pages.length).toBeGreaterThan(0);
    expect(catalog.pages.every((entry) => semver.satisfies(version, entry.appliesTo))).toBe(true);
  });

  it.each(["mcp", "mcp server", "attach_mcp_server", "register_mcp_server"])(
    "ranks the remote MCP servers article first for %s",
    async (query) => {
      const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
      expect(searchHelp(catalog, query)[0]?.page.id).toBe("mcp-servers");
    },
  );

  it("ranks the MCP client article in the top 3 for 'mcp client'", async () => {
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    expect(
      searchHelp(catalog, "mcp client")
        .slice(0, 3)
        .map((r) => r.page.id),
    ).toContain("mcp-access");
  });

  it.each([
    "mcp_server_unreachable",
    "mcp_server_auth_failed",
    "mcp_server_credentials_unavailable",
    "mcp_server_error",
    "mcp_tool_not_allowed",
    "mcp_tool_removed",
    "mcp_call_timeout",
    "mcp_servers_off",
    "mcp_call_limit",
    "mcp_unavailable",
  ])("ranks the article for %s first", async (code) => {
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    expect(searchHelp(catalog, code)[0]?.page.id).toBe(`errors/${code.replaceAll("_", "-")}`);
  });

  it("ranks the MCP servers article first for coding agent MCP queries", async () => {
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    for (const query of ["coding agent mcp", "readOnlyHint codex", "codex mcp tools", "mcp server"]) {
      expect(searchHelp(catalog, query)[0]?.page.id, query).toBe("mcp-servers");
    }
  });

  it("ranks the pin-load failure article first for its run error code", async () => {
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    for (const query of ["coding_failure_mcp_pins_unavailable", "coding_mcp_pins_unavailable"]) {
      expect(searchHelp(catalog, query)[0]?.page.id, query).toBe("errors/coding-mcp-pins-unavailable");
    }
  });

  it("ranks the gateway-wake failure article first for its run error code", async () => {
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    for (const query of ["coding_failure_mcp_gateway_unavailable", "coding_mcp_gateway_unavailable"]) {
      expect(searchHelp(catalog, query)[0]?.page.id, query).toBe("errors/coding-mcp-gateway-unavailable");
    }
  });

  it("leaves invalid_arguments (shared by many built-in tools) out of the MCP error articles", async () => {
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    for (const page of catalog.pages.filter((entry) => entry.id.startsWith("errors/mcp-"))) {
      expect(page.markdown, page.id).not.toMatch(/invalid_arguments\b/);
    }
  });

  it("has a page for each MCP server error code", async () => {
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    for (const code of [
      "mcp_server_unreachable",
      "mcp_server_auth_failed",
      "mcp_server_credentials_unavailable",
      "mcp_server_error",
      "mcp_tool_not_allowed",
      "mcp_tool_removed",
      "mcp_call_timeout",
      "mcp_servers_off",
      "mcp_call_limit",
      "mcp_unavailable",
    ]) {
      const id = `errors/${code.replaceAll("_", "-")}`;
      expect(catalog.pages.find((entry) => entry.id === id)?.markdown, id).toContain(`\`${code}`);
    }
  });

  it.each([
    "get_run_steps",
    "run steps",
    "WARDBY_RUN_STEPS",
    "RUN_STEP_RETENTION_DAYS",
    "lastStep",
    "what is my run doing",
    "coding run steps",
    "codex run steps",
    "claude code run steps",
    "viewer step event",
    "WARDBY_RUN_STEPS_LISTEN",
    "WARDBY_RUN_STEPS_URL",
  ])("ranks the run steps article first for %s", async (query) => {
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    expect(searchHelp(catalog, query)[0]?.page.id).toBe("run-steps");
  });

  it.each(["pane steps", "recent steps pane"])("finds the run pane article for %s", async (query) => {
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    expect(
      searchHelp(catalog, query)
        .slice(0, 2)
        .map((r) => r.page.id),
    ).toContain("claude-code-run-pane");
  });
});
