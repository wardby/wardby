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

describe("multiple-repository help articles", () => {
  it.each([
    ["multiple repositories", "multi-repository-runs"],
    ["fork sync", "fork-sync"],
    ["read-only repository", "multi-repository-runs"],
  ])("finds %s", (query, id) => {
    expect(top3(query)).toContain(id);
  });

  it.each([
    ["repository_ref_unreadable", "errors/repository-ref-unreadable"],
    ["partially_published", "errors/partially-published"],
    ["repository_set_too_large", "errors/repository-set-too-large"],
    ["invalid_repositories", "errors/invalid-repositories"],
    ["repository_name_taken", "errors/repository-name-taken"],
    ["repository_name_invalid", "errors/repository-name-invalid"],
    ["coding_repository_unresolved", "errors/coding-repository-unresolved"],
    ["coding_repositories_unsupported", "errors/coding-repositories-unsupported"],
    ["vcs_read_only_fetch_failed", "errors/vcs-read-only-fetch-failed"],
  ])("finds %s", (code, id) => {
    expect(top3(code)).toContain(id);
  });

  it("applies to the release that ships multiple repositories", () => {
    for (const id of ["multi-repository-runs", "fork-sync"]) {
      expect(catalog.pages.find((p) => p.id === id)?.appliesTo).toBe(">=0.9.13");
    }
  });
});
