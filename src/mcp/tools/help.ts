import type { HelpCatalog, HelpPage } from "../../help/catalog.js";
import { loadBundledHelpCatalog } from "../../help/runtime.js";
import { findHelpPage, searchHelp } from "../../help/search.js";
import { McpError } from "../errors.js";
import type { WardbyMcpServer } from "../server.js";
import { textResult } from "./text-result.js";

export type HelpCatalogLoader = () => Promise<HelpCatalog>;

function publicArticle(page: HelpPage) {
  return {
    id: page.id,
    title: page.title,
    summary: page.summary,
    audience: page.audience,
    tags: page.tags,
    appliesTo: page.appliesTo,
    headings: page.headings,
    markdown: page.markdown,
  };
}

/** Registers release-bundled, read-only help without exposing any instance data or credentials. */
export function registerHelpTools(mcp: WardbyMcpServer, loadCatalog: HelpCatalogLoader = loadBundledHelpCatalog): void {
  mcp.registerTool({
    name: "search_help",
    description:
      "Search Wardby's bundled help: how each feature works, setup procedures, and an article for every error " +
      "code (id errors/<code>). Call it before guessing how a tool behaves or why a call was refused or a run " +
      "failed. Query by tool name, feature or error code; read a result with get_help_article. Offline fuzzy " +
      "matching over this release's help.",
    permission: "agents:read",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", minLength: 1, maxLength: 200 } },
      required: ["query"],
      additionalProperties: false,
    },
    handler: async (args: { query: string }) => {
      const query = args.query.trim();
      if (!query) throw new McpError(400, "search_help requires a non-empty query.");
      const results = searchHelp(await loadCatalog(), query).slice(0, 10);
      return textResult({
        results: results.map((result) => ({
          id: result.page.id,
          title: result.page.title,
          summary: result.page.summary,
          audience: result.page.audience,
          tags: result.page.tags,
          ...(result.matchedHeading ? { matchedHeading: result.matchedHeading.text } : {}),
          excerpt: result.excerpt,
        })),
      });
    },
  });

  mcp.registerTool({
    name: "get_help_article",
    description:
      "Read one complete Wardby self-hosted help article by its id. An error code's article is errors/<code>; " +
      "underscores in the code may be written as they are (errors/mcp_unavailable finds errors/mcp-unavailable).",
    permission: "agents:read",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1, maxLength: 120 } },
      required: ["id"],
      additionalProperties: false,
    },
    handler: async (args: { id: string }) => {
      const id = args.id.trim();
      if (!id) throw new McpError(400, "get_help_article requires a non-empty id.");
      const page = findHelpPage(await loadCatalog(), id);
      if (!page) throw new McpError(404, `Help article "${id}" not found.`);
      return textResult(publicArticle(page));
    },
  });
}
