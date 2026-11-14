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

describe("git history help articles", () => {
  it.each(["git history", "gitHistory", "remote link", "git merge fork sync"])("finds git-history for %s", (query) => {
    expect(top3(query)).toContain("git-history");
  });

  it.each([
    ["repository_remote_invalid", "errors/repository-remote-invalid"],
    ["repository_remote_needs_history", "errors/repository-remote-needs-history"],
    ["vcs_remote_fetch_failed", "errors/vcs-remote-fetch-failed"],
    ["vcs_result_bundle_invalid", "errors/vcs-result-bundle-invalid"],
    ["vcs_result_bundle_too_large", "errors/vcs-result-bundle-too-large"],
    ["vcs_result_history_invalid", "errors/vcs-result-history-invalid"],
    ["vcs_result_commit_limit", "errors/vcs-result-commit-limit"],
    ["vcs_result_commit_unsafe", "errors/vcs-result-commit-unsafe"],
    ["vcs_result_path_excluded", "errors/vcs-result-path-excluded"],
    ["worker_git_unavailable", "errors/worker-git-unavailable"],
  ])("finds %s", (code, id) => {
    expect(top3(code)).toContain(id);
  });

  it("applies to the release that ships git history", () => {
    for (const page of catalog.pages.filter(
      (p) => p.id === "git-history" || /^errors\/(repository-remote|vcs-remote|vcs-result|worker-git)/.test(p.id),
    )) {
      expect(page.appliesTo).toBe(">=0.9.13");
    }
  });
});
