import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import { buildHelpCatalog, type HelpCatalog } from "./catalog.js";
import { searchHelp } from "./search.js";

let catalog: HelpCatalog;
beforeAll(async () => {
  catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
});

const top3 = (query: string) =>
  searchHelp(catalog, query)
    .slice(0, 3)
    .map((r) => r.page.id);

describe("agent prompt history help", () => {
  it.each(["restore_agent_prompt_version", "list_agent_prompt_versions", "prompt history", "roll back agent prompt"])(
    "finds %s",
    (query) => {
      expect(top3(query)).toContain("agent-prompt-history");
    },
  );

  it.each([
    ["agent_prompt_version_not_found", "errors/agent-prompt-version-not-found"],
    ["agent_prompt_version_conflict", "errors/agent-prompt-version-conflict"],
    ["agent_prompt_version_is_latest", "errors/agent-prompt-version-is-latest"],
  ])("finds %s", (code, id) => {
    expect(top3(code)).toContain(id);
  });
});
