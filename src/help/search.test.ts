import { describe, expect, it } from "vitest";
import type { HelpCatalog, HelpPage } from "./catalog.js";
import { searchHelp } from "./search.js";

function page(overrides: Partial<HelpPage>): HelpPage {
  return {
    id: "general",
    title: "General help",
    summary: "General Wardby guidance.",
    audience: "all",
    tags: ["general"],
    appliesTo: ">=0.2.1",
    sourcePath: "general.md",
    markdown: "# General help",
    plainText: "General Wardby guidance.",
    headings: [{ level: 1, text: "General help", slug: "general-help" }],
    ...overrides,
  };
}

const catalog: HelpCatalog = {
  schemaVersion: 1,
  pages: [
    page({
      id: "deploy-gke",
      title: "Deploy Wardby on GKE Autopilot",
      summary: "Create a Kubernetes cluster with private Cloud SQL.",
      tags: ["deployment", "gke", "kubernetes"],
      plainText: "Deploy Wardby on GKE Autopilot. Create a Kubernetes cluster with private Cloud SQL.",
      headings: [
        { level: 1, text: "Deploy Wardby on GKE Autopilot", slug: "deploy-wardby-on-gke-autopilot" },
        { level: 2, text: "Prepare Cloud SQL", slug: "prepare-cloud-sql" },
      ],
    }),
    page({
      id: "coding-workers",
      title: "Troubleshoot coding workers",
      summary: "Configure Codex and Claude Code worker isolation.",
      tags: ["coding-agents", "isolation"],
      plainText: "Configure Codex and Claude Code worker isolation before a coding run.",
      headings: [{ level: 1, text: "Troubleshoot coding workers", slug: "troubleshoot-coding-workers" }],
    }),
    page({
      id: "review-fix-rounds",
      title: "Automatic review fix rounds",
      summary: "Let wardby fix its own review's findings on pull requests its runs opened, with a round cap.",
      tags: ["github", "code-review", "review_fix", "autofix", "fix-round", "pull-requests"],
      plainText:
        "Automatic review fix rounds. Link an agent with the review_fix trigger and wardby will try to fix its " +
        "own review's findings automatically. A round starts when wardby's own review check comes back " +
        "CHANGES_REQUESTED. Rounds are tracked with wardby-autofix labels on the pull request.",
      headings: [{ level: 1, text: "Automatic review fix rounds", slug: "automatic-review-fix-rounds" }],
    }),
    page({
      id: "related-pull-requests",
      title: "Related pull requests across repositories",
      summary:
        "Wardby lists the other pull requests from the same request in each pull request's description, " +
        "with a suggested merge order.",
      tags: ["github", "pull-requests", "multi-repo", "merge-order", "related", "siblings", "continuePriorRun"],
      plainText:
        "Related pull requests across repositories. Wardby adds a Related pull requests section to each pull " +
        "request's description, with links, state, and a suggested merge order. A follow-up task lists every " +
        "open sibling pull request with the continuePriorRun value that continues it.",
      headings: [
        {
          level: 1,
          text: "Related pull requests across repositories",
          slug: "related-pull-requests-across-repositories",
        },
        {
          level: 2,
          text: "Follow-up runs and sibling pull requests",
          slug: "follow-up-runs-and-sibling-pull-requests",
        },
      ],
    }),
    page({
      id: "agent-recipes",
      title: "Agent recipes",
      summary:
        "Two copyable agent setups, an architecture keeper and a per-language builder, with the version, " +
        "GitHub App, and webhook prerequisites each needs, written as a procedure an MCP assistant can follow.",
      tags: [
        "recipes",
        "examples",
        "architecture",
        "builder",
        "router",
        "mention",
        "push",
        "getting-started",
        "fan-out",
        "parallel-delegations",
        "parallelDelegations",
        "maxDelegationsPerRun",
      ],
      plainText:
        "Agent recipes. A lead that fans out: the calls run one after another unless you also set " +
        "parallelDelegations: true, which starts the delegations the lead makes in one turn together.",
      headings: [
        { level: 1, text: "Agent recipes", slug: "agent-recipes" },
        { level: 2, text: "Step 2C (optional): a lead that fans out", slug: "step-2c-optional-a-lead-that-fans-out" },
      ],
    }),
    page({
      id: "errors/continuation-closed",
      title: "Continuation's pull request is no longer open",
      summary: "A run asked to continue a pull request that was already merged or closed, so nothing was pushed.",
      tags: ["error", "vcs", "pull-requests", "continuation", "continuePriorRun"],
      plainText:
        "A run started with continuePriorRun reuses the branch and pull request the named run originally " +
        "opened. A run that stopped with category continuation_closed got a definite answer that the pull " +
        "request is no longer open: it was merged or closed.",
      headings: [
        {
          level: 1,
          text: "Continuation's pull request is no longer open",
          slug: "continuations-pull-request-is-no-longer-open",
        },
      ],
    }),
  ],
};

describe("searchHelp", () => {
  it("ranks exact title and tag matches before broad text matches", () => {
    expect(searchHelp(catalog, "gke").map((result) => result.page.id)).toEqual(["deploy-gke"]);
  });

  it("matches multiple partial and misspelled terms", () => {
    const [result] = searchHelp(catalog, "kuber clod sql");
    expect(result.page.id).toBe("deploy-gke");
    expect(result.matchedHeading?.text).toBe("Prepare Cloud SQL");
    expect(result.excerpt).toContain("Cloud SQL");
  });

  it("uses a stable id tie-breaker", () => {
    const tied: HelpCatalog = { ...catalog, pages: [...catalog.pages].reverse() };
    expect(searchHelp(tied, "coding").map((result) => result.page.id)).toEqual(["coding-workers"]);
  });

  it("finds the review fix rounds article by trigger name, tag, and feature phrase", () => {
    expect(searchHelp(catalog, "review_fix")[0]?.page.id).toBe("review-fix-rounds");
    expect(searchHelp(catalog, "autofix")[0]?.page.id).toBe("review-fix-rounds");
    expect(searchHelp(catalog, "fix round")[0]?.page.id).toBe("review-fix-rounds");
  });

  it("finds the related pull requests article by name, merge order, and continuation phrase", () => {
    expect(searchHelp(catalog, "related pull requests")[0]?.page.id).toBe("related-pull-requests");
    expect(searchHelp(catalog, "merge order")[0]?.page.id).toBe("related-pull-requests");
    expect(searchHelp(catalog, "continuePriorRun sibling")[0]?.page.id).toBe("related-pull-requests");
  });

  it("finds the continuation-closed error article by its failure category", () => {
    expect(searchHelp(catalog, "continuation_closed")[0]?.page.id).toBe("errors/continuation-closed");
  });

  it("finds the agent recipes article by the parallelDelegations flag", () => {
    expect(searchHelp(catalog, "parallelDelegations")[0]?.page.id).toBe("agent-recipes");
    expect(searchHelp(catalog, "parallel delegations")[0]?.page.id).toBe("agent-recipes");
  });
});

describe("local repositories help", () => {
  it("is found for the obvious queries, and each error code finds its article", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));

    for (const query of ["local repo", "worktree", "without github app", "LOCAL_REPO_ROOTS", "trusted folders"]) {
      const ids = searchHelp(catalog, query).map((result) => result.page.id);
      expect(ids, query).toContain("local-repositories");
    }

    for (const code of [
      "local_repo_not_allowed",
      "local_repo_not_found",
      "local_ref_not_found",
      "local_ref_invalid",
      "local_path_invalid",
      "local_branch_conflict",
      "vcs_github_not_configured",
    ]) {
      const id = `errors/${code.replaceAll("_", "-")}`;
      const results = searchHelp(catalog, code);
      expect(results[0]?.page.id, code).toBe(id);
      expect(catalog.pages.find((entry) => entry.id === id)?.markdown, id).toContain(`\`${code}\``);
    }
  });
});

describe("coding provider not configured help", () => {
  it("is found by both codes and the variables an operator would search for", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    const id = "errors/coding-provider-not-configured";
    const markdown = catalog.pages.find((entry) => entry.id === id)?.markdown;
    for (const code of ["coding_provider_not_configured:codex", "coding_provider_not_configured:claude-code"]) {
      expect(markdown, code).toContain(`\`${code}\``);
    }
    for (const query of [
      "coding_provider_not_configured",
      "coding_provider_not_configured:codex",
      "coding_provider_not_configured:claude-code",
      "CODING_WORKER_IMAGE",
      "CODING_CLAUDE_WORKER_IMAGE",
    ]) {
      expect(searchHelp(catalog, query)[0]?.page.id, query).toBe(id);
    }
  });
});

describe("build worker image help", () => {
  it("is found for the obvious queries", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    for (const query of ["worker image", "custom image", "Go", "Java", "other language"]) {
      expect(searchHelp(catalog, query)[0]?.page.id, query).toBe("build-worker-image");
    }
  });
});

describe("repository instructions and skills help", () => {
  it("is found for the obvious queries", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    const id = "repo-instructions-and-skills";

    for (const query of ["repoSkills", "claudeBareMode", "SKILL.md", "CLAUDE.md", "AGENTS.md", "repo skills"]) {
      const ids = searchHelp(catalog, query).map((result) => result.page.id);
      expect(ids, query).toContain(id);
    }
  });
});

describe("Slack notification help", () => {
  it("is found by the main article for broad queries and tool names in top 3", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    const id = "slack-notifications";
    for (const query of [
      "slack",
      "notification",
      "channel",
      "link_notification_channel",
      "test_notification_channel",
      "slack thread",
    ]) {
      const results = searchHelp(catalog, query);
      expect(
        results.slice(0, 3).map((r) => r.page.id),
        query,
      ).toContain(id);
    }
  });

  it("finds each error code in its corresponding error article", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));

    for (const [code, articleId] of [
      ["not_in_channel", "errors/slack-channel-unreachable"],
      ["invalid_auth", "errors/slack-auth-failed"],
      ["slack not configured", "errors/slack-not-configured"],
    ] as const) {
      const results = searchHelp(catalog, code);
      expect(results[0]?.page.id, code).toBe(articleId);
    }
  });
});
