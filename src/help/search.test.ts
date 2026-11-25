import { describe, expect, it } from "vitest";
import type { HelpCatalog, HelpPage } from "./catalog.js";
import { findHelpPage, searchHelp } from "./search.js";

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

  it("is found for workerImageRef", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    const ids = searchHelp(catalog, "workerImageRef")
      .slice(0, 3)
      .map((result) => result.page.id);
    expect(ids).toContain("build-worker-image");
    expect(ids).toContain("build-claude-code-image");
  });
});

describe("build Claude Code image help", () => {
  it("is found for the obvious queries", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    for (const query of ["custom image claude code", "ruby", "tool runner"]) {
      expect(searchHelp(catalog, query)[0]?.page.id, query).toBe("build-claude-code-image");
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

describe("durable executor ownership-loss help", () => {
  it("is found by the log event name and the executor setting", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    for (const query of ["run_ownership_lost", "EXECUTOR=dbos", "durable executor"]) {
      expect(searchHelp(catalog, query)[0]?.page.id, query).toBe("observability");
    }
  });
});

describe("allowlist refusal help", () => {
  it('finds each allowlist refusal code\'s article, and "allowlist" finds them', async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));

    const codes = [
      "wardby_package_not_allowed",
      "wardby_package_not_allowed_pending",
      "wardby_graph_incomplete",
      "wardby_graph_limit",
    ];
    for (const code of codes) {
      const id = `errors/${code.replace(/^wardby_/, "").replaceAll("_", "-")}`;
      expect(searchHelp(catalog, code)[0]?.page.id, code).toBe(id);
      expect(catalog.pages.find((entry) => entry.id === id)?.markdown, id).toContain(`\`${code}\``);
    }

    const ids = searchHelp(catalog, "allowlist").map((result) => result.page.id);
    for (const code of codes) {
      expect(ids, code).toContain(`errors/${code.replace(/^wardby_/, "").replaceAll("_", "-")}`);
    }
  });
});

describe("package audit mode help", () => {
  it("is found for the obvious queries and by allowlist", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    for (const query of [
      "package audit",
      "package audit mode",
      "packageAuditMode",
      "packageAuditMinutes",
      "audit mode",
      "approve_audited_packages",
    ]) {
      expect(searchHelp(catalog, query)[0]?.page.id, query).toBe("package-audit-mode");
    }
    expect(searchHelp(catalog, "allowlist").map((r) => r.page.id)).toContain("package-audit-mode");
  });
});

describe("Substrate Codex help", () => {
  it("is found for the obvious queries", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    const top3 = (query: string) =>
      searchHelp(catalog, query)
        .slice(0, 3)
        .map((r) => r.page.id);
    for (const query of ["substrate codex", "codex substrate", "CODING_WORKER_IMAGE substrate"]) {
      expect(top3(query), query).toContain("job-launcher-substrate");
    }
    expect(top3("substrate warm rounds codex")).toEqual(
      expect.arrayContaining(["job-launcher-substrate", "substrate-warm-rounds"]),
    );
  });
});

describe("Substrate MCP help", () => {
  it("is found for the obvious queries", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    const top3 = (query: string) =>
      searchHelp(catalog, query)
        .slice(0, 3)
        .map((r) => r.page.id);
    for (const query of ["substrate mcp", "mcp tools substrate"]) {
      expect(top3(query), query).toContain("job-launcher-substrate");
    }
    expect(top3("X-Wardby-Mcp-Token")).toContain("mcp-servers");
    expect(top3("mcp server")).toContain("mcp-servers");
  });
});

describe("Native sandbox on Substrate help", () => {
  it("is found for the obvious queries", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    const top3 = (query: string) =>
      searchHelp(catalog, query)
        .slice(0, 3)
        .map((r) => r.page.id);
    for (const query of ["substrate native", "native sandbox substrate"]) {
      expect(top3(query), query).toContain("native-sandbox");
    }
    expect(top3("native_sandbox_substrate_failed")).toContain("errors/native-sandbox-substrate-failed");
  });
});

describe("Substrate multi-repository help", () => {
  it("is found for the obvious queries", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    const top3 = (query: string) =>
      searchHelp(catalog, query)
        .slice(0, 3)
        .map((r) => r.page.id);
    for (const query of [
      "substrate repositories",
      "substrate multi repository",
      "substrate multi-repo",
      "extra repositories substrate",
    ]) {
      expect(top3(query), query).toContain("job-launcher-substrate");
    }
    for (const query of ["read-only repository substrate", "substrate read-only repository"]) {
      expect(top3(query), query).toContain("multi-repository-runs");
    }
    expect(top3("repositories")).toContain("multi-repository-runs");
    for (const query of ["multi-repository", "extra repositories"]) {
      const ids = searchHelp(catalog, query).map((r) => r.page.id);
      expect(ids.indexOf("multi-repository-runs"), query).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf("multi-repository-runs"), query).toBeLessThanOrEqual(ids.indexOf("job-launcher-substrate"));
    }
  });
});

describe("Substrate dependency cache help", () => {
  it("is found for the obvious queries", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    const top3 = (query: string) =>
      searchHelp(catalog, query)
        .slice(0, 3)
        .map((r) => r.page.id);
    for (const query of ["substrate dependency cache", "reused_workspace", "digest_mismatch"]) {
      expect(top3(query), query).toContain("dependency-cache");
    }
    expect(top3("job launcher")).toContain("job-launcher-substrate");
    for (const query of ["dependency cache warm rounds", "dependency cache warm round"]) {
      expect(top3(query), query).toContain("substrate-warm-rounds");
    }
  });
});

describe("Substrate custom image help", () => {
  it("is found for the obvious queries", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    const top3 = (query: string) =>
      searchHelp(catalog, query)
        .slice(0, 3)
        .map((r) => r.page.id);
    for (const query of ["substrate custom image", "workerImageRef substrate"]) {
      expect(
        top3(query).some((id) => id === "job-launcher-substrate" || id === "build-claude-code-image"),
        query,
      ).toBe(true);
    }
    expect(top3("substrate_image_unready")).toContain("errors/substrate-image-unready");
    expect(top3("substrate_bridge_incompatible")).toContain("errors/substrate-bridge-incompatible");
    expect(top3("substrate_image_incomplete")).toContain("errors/substrate-image-incomplete");
  });
});

describe("Substrate services help", () => {
  it("is found for the obvious queries", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    const top3 = (query: string) =>
      searchHelp(catalog, query)
        .slice(0, 3)
        .map((r) => r.page.id);
    const found = [...top3("substrate services"), ...top3("postgres substrate")];
    expect(found).toContain("coding-services");
    expect(found).toContain("job-launcher-substrate");
    expect(
      top3("startCommand").some((id) => id === "errors/service-launcher-unsupported" || id === "coding-services"),
    ).toBe(true);
    expect(top3("substrateImage")).toContain("coding-services");
    expect(top3("WARDBY_SERVICE_SETUP_DONE")).toContain("errors/service-unready");
    expect(top3("substrate_bridge_service_unready")).toContain("errors/service-unready");
    expect(top3("coding_service_unready")).toContain("errors/service-unready");
    expect(top3("substrate_feature_unsupported")).toContain("errors/substrate-feature-unsupported");
  });
});

describe("pnpm and yarn help", () => {
  it("is found for the obvious queries", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    for (const query of ["pnpm", "yarn", "yarn berry", "pnpm-lock.yaml", "corepack"]) {
      expect(searchHelp(catalog, query)[0]?.page.id, query).toBe("coding-packages");
    }
  });

  it("finds the budget-exhausted article for the allowed overrun setting", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    for (const query of ["allowedOverrunPercent", "budget overrun", "overrun_unavailable", "overrun not available"]) {
      const ids = searchHelp(catalog, query)
        .slice(0, 3)
        .map((result) => result.page.id);
      expect(ids).toContain("errors/budget-exhausted");
    }
  });

  it("finds the budget-stopped draft articles", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    for (const query of ["budget stopped draft", "continue draft issue", "skipped review"]) {
      const ids = searchHelp(catalog, query)
        .slice(0, 3)
        .map((result) => result.page.id);
      expect(
        ids.some((id) => id === "errors/budget-exhausted" || id === "code-review-agents"),
        query,
      ).toBe(true);
    }
  });
});

describe("secret in value help", () => {
  it("is found for the error codes and the obvious datastore and memory queries", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    const id = "errors/secret-in-value";
    for (const query of ["secret_in_value", "secret_check_unavailable", "datastore secret", "memory secret"]) {
      expect(searchHelp(catalog, query)[0]?.page.id, query).toBe(id);
    }
    expect(catalog.pages.find((entry) => entry.id === id)?.markdown).toContain("`secret_in_value`");
  });
});

describe("JFrog Artifactory help", () => {
  it("is found for the obvious queries", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    for (const query of ["artifactory", "jfrog", "private packages", "REGISTRY_JFROG_URL"]) {
      expect(searchHelp(catalog, query)[0]?.page.id, query).toBe("jfrog-artifactory");
    }
  });
});

describe("host provider errors help", () => {
  it("is the first result for every registration code", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    const id = "errors/host-provider-error";
    const markdown = catalog.pages.find((entry) => entry.id === id)?.markdown;
    for (const code of [
      "host_provider_not_found",
      "host_provider_missing_operation",
      "host_provider_tool_not_found",
      "host_provider_secret_not_found",
      "host_provider_secret_not_brokered",
      "host_provider_secret_hosts",
      "host_provider_secret_placement",
      "host_provider_webhook_secret_shared",
      "host_provider_webhook_secret_short",
      "host_provider_webhook_secret_attached",
      "host_provider_permission_secret_shared",
      "host_provider_secret_link_stale",
      "host_provider_username_is_secret",
      "host_provider_in_use",
      "host_provider_operation_not_bound",
      "host_provider_tool_deleted",
    ]) {
      expect(searchHelp(catalog, code)[0]?.page.id, code).toBe(id);
      expect(markdown, code).toContain(`\`${code}\``);
    }
  });
});

describe("MCP error code help", () => {
  it("ranks the article whose tag is the whole query first, even when one code's words are inside another's", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));

    expect(searchHelp(catalog, "mcp_unavailable")[0]?.page.id).toBe("errors/mcp-unavailable");
    expect(searchHelp(catalog, "mcp_server_credentials_unavailable")[0]?.page.id).toBe(
      "errors/mcp-server-credentials-unavailable",
    );
    expect(searchHelp(catalog, "  MCP_UNAVAILABLE ")[0]?.page.id).toBe("errors/mcp-unavailable");
  });

  it("adds the exact-tag bonus only for the whole query", () => {
    const pages: HelpCatalog = {
      ...catalog,
      pages: [
        page({ id: "errors/a-b-c", title: "a_b_c (a_b_c)", tags: ["a_b_c"] }),
        page({ id: "errors/b-c", title: "b_c (b_c)", tags: ["b_c"] }),
      ],
    };
    expect(searchHelp(pages, "b_c")[0]?.page.id).toBe("errors/b-c");
    expect(searchHelp(pages, "a_b_c")[0]?.page.id).toBe("errors/a-b-c");
  });
});

describe("document edits help", () => {
  it("is found for the tool names, the error code and the obvious queries", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const corpus = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    const top3 = (q: string) =>
      searchHelp(corpus, q)
        .slice(0, 3)
        .map((r) => r.page.id);
    for (const q of ["list_document_versions", "restore_document_version", "edits tray", "restore version"]) {
      expect(top3(q), q).toContain("document-edits");
    }
    expect(searchHelp(corpus, "document_version_not_found")[0]?.page.id).toBe("errors/document-version-not-found");
  });
});

describe("brokered secrets basic placement help", () => {
  it("is found for basic auth, jira token and base64", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const corpus = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    const top3 = (q: string) =>
      searchHelp(corpus, q)
        .slice(0, 3)
        .map((r) => r.page.id);
    for (const q of ["basic auth", "jira token", "base64", "http basic"]) {
      expect(top3(q), q).toContain("brokered-secrets");
    }
  });
});

describe("OAuth discovery help", () => {
  it("is found for atlassian mcp, oauth discovery and the error code", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const corpus = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    const top3 = (q: string) =>
      searchHelp(corpus, q)
        .slice(0, 3)
        .map((r) => r.page.id);
    expect(top3("atlassian mcp")).toContain("oauth-secrets");
    expect(top3("oauth discovery")).toEqual(
      expect.arrayContaining(["oauth-secrets", "errors/secret-oauth-discovery-failed"]),
    );
    expect(searchHelp(corpus, "secret_oauth_discovery_failed")[0]?.page.id).toBe(
      "errors/secret-oauth-discovery-failed",
    );
  });
});

describe("changing a secret's value help", () => {
  it("is found for rotate secret, update secret and the error code", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const corpus = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    const top3 = (q: string) =>
      searchHelp(corpus, q)
        .slice(0, 3)
        .map((r) => r.page.id);
    for (const q of ["rotate secret", "update secret", "change secret value"]) {
      expect(top3(q), q).toEqual(expect.arrayContaining(["brokered-secrets"]));
    }
    expect(searchHelp(corpus, "secret_link_superseded")[0]?.page.id).toBe("errors/secret-link-superseded");
  });
});

describe("coding workflows help (#582)", () => {
  it("is found for workflow, .claude/workflows and workflowArgs, and each error code finds its article", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const corpus = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    const top3 = (q: string) =>
      searchHelp(corpus, q)
        .slice(0, 3)
        .map((r) => r.page.id);
    for (const q of [
      "workflow",
      ".claude/workflows",
      "workflowArgs",
      "workflow script",
      "replyField",
      "workflow reply",
    ]) {
      expect(top3(q), q).toContain("coding-workflows");
    }
    expect(searchHelp(corpus, "coding_failure_workflow_unavailable")[0]?.page.id).toBe(
      "errors/coding-workflow-unavailable",
    );
    expect(searchHelp(corpus, "coding_failure_workflow_failed")[0]?.page.id).toBe("errors/coding-workflow-failed");
  });

  it("finds the branch-only article (#586)", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const corpus = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    const top3 = (q: string) =>
      searchHelp(corpus, q)
        .slice(0, 3)
        .map((r) => r.page.id);
    for (const q of ["branch only", "no pull request", "pullRequest none", "push branch without pull request"]) {
      expect(top3(q), q).toContain("coding-branch-only");
    }
  });
});

describe("native agent documents help", () => {
  it("is found for the obvious queries", async () => {
    const { buildHelpCatalog } = await import("./catalog.js");
    const { fileURLToPath } = await import("node:url");
    const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
    for (const query of ["native agent documents", "doc_create", "documentTools"]) {
      expect(searchHelp(catalog, query)[0]?.page.id, query).toBe("native-agent-documents");
    }
  });

  it.each(["document_tools_invalid", "document_agent_grant_level", "document_run_limit"])(
    "finds the article for %s",
    async (code) => {
      const { buildHelpCatalog } = await import("./catalog.js");
      const { fileURLToPath } = await import("node:url");
      const catalog = await buildHelpCatalog(fileURLToPath(new URL("../../help/", import.meta.url)));
      expect(searchHelp(catalog, code)[0]?.page.id, code).toBe(`errors/${code.replaceAll("_", "-")}`);
    },
  );
});

describe("findHelpPage", () => {
  const errors: HelpCatalog = {
    schemaVersion: 1,
    pages: [page({ id: "errors/mcp-unavailable" }), page({ id: "deploy-gke" })],
  };

  it("finds an exact id", () => {
    expect(findHelpPage(errors, "deploy-gke")?.id).toBe("deploy-gke");
  });

  it("reads underscores as hyphens, so an error code as written finds its article", () => {
    expect(findHelpPage(errors, "errors/mcp_unavailable")?.id).toBe("errors/mcp-unavailable");
  });

  it("finds nothing for an id that matches neither way", () => {
    expect(findHelpPage(errors, "errors/no_such_code")).toBeUndefined();
    expect(findHelpPage(errors, "missing")).toBeUndefined();
  });
});
