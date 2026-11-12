import { randomUUID } from "node:crypto";
import { createPrismaClient } from "../../core/db.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaContainerExecutionStore } from "./container.js";
import { defaultRepositoryName } from "../../coding/repository-names.js";

const db = createPrismaClient();
const suffix = randomUUID();
const principalId = `container-principal-${suffix}`;
const agentId = `container-agent-${suffix}`;

// Tests that create active (slot-holding) or queued coding runs live in
// src/core/coding-concurrency.database.test.ts instead: they depend on
// global slot/queue state and race each other across parallel test files.
describe.skipIf(!process.env.DATABASE_URL)("PrismaContainerExecutionStore (PostgreSQL)", () => {
  beforeAll(async () => {
    await db.principal.create({ data: { id: principalId, subject: principalId } });
    await db.agent.create({
      data: {
        id: agentId,
        name: agentId,
        systemPrompt: "code safely",
        model: "gpt-5.6-luna",
        budgetUsd: 1,
        kind: "coding",
        ownerId: principalId,
      },
    });
  });

  afterAll(async () => {
    await db.agent.deleteMany({ where: { id: agentId } });
    await db.principal.deleteMany({ where: { id: principalId } });
    await db.$disconnect();
  });

  it("loads the agent's current profile repository and its authorization stamp with the run", async () => {
    const runId = `container-auth-${randomUUID()}`;
    try {
      await db.codingAgentProfile.upsert({
        where: { agentId },
        create: {
          agentId,
          repository: "openai/example",
          protectedPaths: ["CODEOWNERS"],
          repositoryAuthorizedVia: "host_permission",
          repositoryAuthorizedById: principalId,
        },
        update: {},
      });
      await db.run.create({ data: { id: runId, agentId, executionManaged: true } });
      await db.codingRun.create({
        data: {
          runId,
          task: "Fix it.",
          repository: "openai/example",
          baseRef: "main",
          headRef: `wardby/run-${runId}`,
          provider: "codex",
          model: "gpt-5.6-luna",
          timeoutSec: 900,
          allowedEgress: [],
          protectedPaths: ["CODEOWNERS"],
          budgetReservedUsd: 1,
        },
      });
      await expect(new PrismaContainerExecutionStore(db).load(runId)).resolves.toMatchObject({
        ownerId: principalId,
        repository: "openai/example",
        profileRepository: "openai/example",
        repositoryAuthorizedVia: "host_permission",
      });
    } finally {
      await db.codingRun.deleteMany({ where: { runId } });
      await db.run.deleteMany({ where: { id: runId } });
      await db.codingAgentProfile.deleteMany({ where: { agentId } });
    }
  });

  it("reports whether the agent's write link for a linked run's repository still exists", async () => {
    const runId = `container-link-${randomUUID()}`;
    try {
      await db.agentRepository.create({
        data: {
          agentId,
          provider: "github",
          repository: "openai/example",
          name: defaultRepositoryName("openai/example"),
          access: "write",
          triggers: [],
          authorizedVia: "admin",
        },
      });
      await db.run.create({ data: { id: runId, agentId, executionManaged: true } });
      await db.codingRun.create({
        data: {
          runId,
          task: "Fix it.",
          repository: "openai/example",
          baseRef: "main",
          headRef: `wardby/run-${runId}`,
          provider: "codex",
          model: "gpt-5.6-luna",
          timeoutSec: 900,
          allowedEgress: [],
          protectedPaths: ["CODEOWNERS"],
          budgetReservedUsd: 1,
          viaRepositoryLink: true,
        },
      });
      const store = new PrismaContainerExecutionStore(db);
      await expect(store.load(runId)).resolves.toMatchObject({
        viaRepositoryLink: true,
        repositoryLinkExists: true,
        repositoryLinkAuthorizedVia: "admin",
      });
      const gone = { viaRepositoryLink: true, repositoryLinkExists: false, repositoryLinkAuthorizedVia: null };
      const link = { agentId, provider: "github", repository: "openai/example" };
      const updateLink = (data: { access?: string; triggers?: string[] }) =>
        db.agentRepository.updateMany({ where: link, data });
      // Downgraded to read: no longer on the list.
      await updateLink({ access: "read" });
      await expect(store.load(runId)).resolves.toMatchObject(gone);
      // Given a trigger: a review link now, not on the list either.
      await updateLink({ access: "write", triggers: ["mention"] });
      await expect(store.load(runId)).resolves.toMatchObject(gone);
      await updateLink({ triggers: [] });
      await expect(store.load(runId)).resolves.toMatchObject({ repositoryLinkExists: true });
      await db.agentRepository.deleteMany({ where: { agentId } });
      await expect(store.load(runId)).resolves.toMatchObject(gone);
    } finally {
      await db.codingRun.deleteMany({ where: { runId } });
      await db.run.deleteMany({ where: { id: runId } });
      await db.agentRepository.deleteMany({ where: { agentId } });
    }
  });

  it("loads a run's repository rows in order, with whether each link is still there and which branches exist", async () => {
    const rootId = `container-repos-root-${randomUUID()}`;
    const runId = `container-repos-${randomUUID()}`;
    const codingRun = (id: string, rootCodingRunId: string | null) => ({
      runId: id,
      task: "Fix it.",
      repository: "openai/example",
      baseRef: "main",
      headRef: `wardby/run-${rootCodingRunId ?? id}`,
      provider: "codex",
      model: "gpt-5.6-luna",
      timeoutSec: 900,
      allowedEgress: [],
      protectedPaths: ["CODEOWNERS"],
      budgetReservedUsd: 1,
      rootCodingRunId,
    });
    try {
      const base = await db.agentRepository.create({
        data: {
          agentId,
          provider: "github",
          repository: "openai/base",
          name: "base",
          access: "read",
          ref: "main",
          triggers: [],
          authorizedVia: "admin",
        },
      });
      const tools = await db.agentRepository.create({
        data: {
          agentId,
          provider: "github",
          repository: "openai/tools",
          name: "tools",
          access: "write",
          triggers: [],
          authorizedVia: "host_permission",
        },
      });
      const docs = await db.agentRepository.create({
        data: {
          agentId,
          provider: "github",
          repository: "openai/docs",
          name: "docs",
          access: "write",
          triggers: [],
          authorizedVia: "admin",
        },
      });
      await db.run.create({ data: { id: rootId, agentId, executionManaged: true } });
      await db.codingRun.create({ data: codingRun(rootId, null) });
      await db.run.create({ data: { id: runId, agentId, executionManaged: true } });
      await db.codingRun.create({ data: codingRun(runId, rootId) });
      const sha = "a".repeat(40);
      const row = (
        id: string,
        position: number,
        link: { id: string; name: string; repository: string },
        access: string,
      ) => ({
        runId: id,
        position,
        name: link.name,
        access,
        provider: "github",
        repository: link.repository,
        requestedRef: "main",
        resolvedSha: sha,
        linkId: link.id,
        ...(access === "write" ? { baseRef: "main", headRef: `wardby/run-${rootId}` } : {}),
      });
      // The root opened a pull request for tools only.
      await db.codingRunRepository.createMany({
        data: [
          row(rootId, 1, base, "read"),
          { ...row(rootId, 2, tools, "write"), pullRequestNumber: 7 },
          row(rootId, 3, docs, "write"),
        ],
      });
      await db.codingRunRepository.createMany({
        data: [row(runId, 3, docs, "write"), row(runId, 1, base, "read"), row(runId, 2, tools, "write")],
      });
      const store = new PrismaContainerExecutionStore(db);
      const loaded = await store.load(runId);
      expect(loaded?.repositories).toEqual([
        expect.objectContaining({
          position: 1,
          name: "base",
          access: "read",
          accessKnown: true,
          repository: "openai/base",
          resolvedSha: sha,
          baseRef: null,
          headRef: null,
          linkId: base.id,
          linkExists: true,
          linkAuthorizedVia: "admin",
          continuesBranch: false,
        }),
        expect.objectContaining({
          position: 2,
          name: "tools",
          access: "write",
          baseRef: "main",
          headRef: `wardby/run-${rootId}`,
          linkExists: true,
          linkAuthorizedVia: "host_permission",
          continuesBranch: true,
          pullRequestNumber: null,
        }),
        expect.objectContaining({ position: 3, name: "docs", continuesBranch: false, linkExists: true }),
      ]);
      // A root run has no earlier branches: nothing continues.
      expect((await store.load(rootId))?.repositories.map((r) => r.continuesBranch)).toEqual([false, false, false]);
      // This run's own published rows never count: only the root or an earlier continuation made a
      // branch, so a reload after this run publishes docs still creates docs' branch off its base.
      await db.codingRunRepository.updateMany({
        where: { runId, name: "docs" },
        data: { resultBranch: `wardby/run-${rootId}`, pullRequestNumber: 9 },
      });
      expect((await store.load(runId))?.repositories.map((r) => [r.name, r.continuesBranch])).toEqual([
        ["base", false],
        ["tools", true],
        ["docs", false],
      ]);
      // A stored access that is neither read nor write is flagged, so the executor refuses the row.
      await db.codingRunRepository.updateMany({ where: { runId, name: "base" }, data: { access: "admin" } });
      expect((await store.load(runId))?.repositories.map((r) => [r.name, r.accessKnown, r.linkExists])).toEqual([
        ["base", false, false],
        ["tools", true, true],
        ["docs", true, true],
      ]);
      await db.codingRunRepository.updateMany({ where: { runId, name: "base" }, data: { access: "read" } });
      // A link whose access changed, or that gained a trigger, or that is gone, no longer authorizes its row.
      await db.agentRepository.update({ where: { id: tools.id }, data: { access: "read" } });
      await db.agentRepository.update({ where: { id: docs.id }, data: { triggers: ["mention"] } });
      await db.agentRepository.delete({ where: { id: base.id } });
      const gone = await store.load(runId);
      expect(gone?.repositories.map((r) => [r.name, r.linkExists, r.linkAuthorizedVia])).toEqual([
        ["base", false, null],
        ["tools", false, null],
        ["docs", false, null],
      ]);
    } finally {
      await db.codingRun.deleteMany({ where: { runId: { in: [runId, rootId] } } });
      await db.run.deleteMany({ where: { id: { in: [runId, rootId] } } });
      await db.agentRepository.deleteMany({ where: { agentId } });
    }
  });

  it("loads no repositories for a single-repository run", async () => {
    const runId = `container-single-${randomUUID()}`;
    try {
      await db.run.create({ data: { id: runId, agentId, executionManaged: true } });
      await db.codingRun.create({
        data: {
          runId,
          task: "Fix it.",
          repository: "openai/example",
          baseRef: "main",
          headRef: `wardby/run-${runId}`,
          provider: "codex",
          model: "gpt-5.6-luna",
          timeoutSec: 900,
          allowedEgress: [],
          protectedPaths: ["CODEOWNERS"],
          budgetReservedUsd: 1,
        },
      });
      await expect(new PrismaContainerExecutionStore(db).load(runId)).resolves.toMatchObject({ repositories: [] });
    } finally {
      await db.codingRun.deleteMany({ where: { runId } });
      await db.run.deleteMany({ where: { id: runId } });
    }
  });

  it("persists a sanitized failure category and opaque diagnostic ID separately from the terminal state", async () => {
    const failedRunId = `container-failed-${randomUUID()}`;
    try {
      await db.run.create({ data: { id: failedRunId, agentId, executionManaged: true } });
      await db.codingRun.create({
        data: {
          runId: failedRunId,
          task: "Never persist this task in failure metadata.",
          repository: "openai/example",
          baseRef: "main",
          headRef: `wardby/run-${failedRunId}`,
          provider: "codex",
          model: "gpt-5.6-luna",
          timeoutSec: 900,
          allowedEgress: [],
          protectedPaths: ["CODEOWNERS"],
          budgetReservedUsd: 1,
        },
      });

      const store = new PrismaContainerExecutionStore(db);
      await store.terminate(failedRunId, "failed", "coding_failure_artifact:coding_diag_opaque", {
        failureCategory: "artifact",
        diagnosticId: "coding_diag_opaque",
      });

      await expect(db.codingRun.findUniqueOrThrow({ where: { runId: failedRunId } })).resolves.toMatchObject({
        failureCategory: "artifact",
        diagnosticId: "coding_diag_opaque",
      });
    } finally {
      await db.codingRun.deleteMany({ where: { runId: failedRunId } });
      await db.run.deleteMany({ where: { id: failedRunId } });
    }
  });

  it("terminate reports whether it changed the row: true once, false when the run already ended", async () => {
    const runningId = `container-term-running-${randomUUID()}`;
    const doneId = `container-term-done-${randomUUID()}`;
    try {
      await db.run.create({ data: { id: runningId, agentId, executionManaged: true, status: "running" } });
      await db.run.create({ data: { id: doneId, agentId, executionManaged: true, status: "succeeded" } });
      const store = new PrismaContainerExecutionStore(db);
      await expect(store.terminate(runningId, "cancelled", "cancelled")).resolves.toBe(true);
      await expect(store.terminate(runningId, "failed", "late")).resolves.toBe(false);
      await expect(store.terminate(doneId, "cancelled", "cancelled")).resolves.toBe(false);
      await expect(db.run.findUniqueOrThrow({ where: { id: runningId } })).resolves.toMatchObject({
        status: "cancelled",
      });
      await expect(db.run.findUniqueOrThrow({ where: { id: doneId } })).resolves.toMatchObject({
        status: "succeeded",
      });
    } finally {
      await db.run.deleteMany({ where: { id: { in: [runningId, doneId] } } });
    }
  });

  it("refuses to claim a run that is no longer pending/running, and leaves no claim behind", async () => {
    const alreadyFailedRunId = `container-already-failed-${randomUUID()}`;
    try {
      await db.run.create({
        data: {
          id: alreadyFailedRunId,
          agentId,
          executionManaged: true,
          status: "failed",
          error: "some_other_failure",
        },
      });
      await db.codingRun.create({
        data: {
          runId: alreadyFailedRunId,
          task: "Fix it.",
          repository: "openai/example",
          baseRef: "main",
          headRef: `wardby/run-${alreadyFailedRunId}`,
          provider: "codex",
          model: "gpt-5.6-luna",
          timeoutSec: 900,
          allowedEgress: [],
          protectedPaths: ["CODEOWNERS"],
          budgetReservedUsd: 1,
        },
      });

      const store = new PrismaContainerExecutionStore(db);
      await expect(store.claimProvisioning(alreadyFailedRunId, "claim-late")).resolves.toBe("unavailable");

      const coding = await db.codingRun.findUniqueOrThrow({ where: { runId: alreadyFailedRunId } });
      expect(coding.jobBackend).toBeNull();
      expect(coding.jobHandle).toBeNull();
      const run = await db.run.findUniqueOrThrow({ where: { id: alreadyFailedRunId } });
      expect(run.status).toBe("failed");
      expect(run.error).toBe("some_other_failure");
    } finally {
      await db.codingRun.deleteMany({ where: { runId: alreadyFailedRunId } });
      await db.run.deleteMany({ where: { id: alreadyFailedRunId } });
    }
  });
  /** A succeeded coding run with a stored result summary; extra CodingRun columns from `data`. */
  async function codingRunWith(runId: string, summary: string, data: Record<string, unknown> = {}) {
    await db.run.create({ data: { id: runId, agentId, executionManaged: true, status: "succeeded" } });
    await db.codingRun.create({
      data: {
        runId,
        task: "Fix it.",
        repository: "openai/example",
        baseRef: "main",
        headRef: `wardby/run-${runId}`,
        provider: "codex",
        model: "gpt-5.6-luna",
        timeoutSec: 900,
        allowedEgress: [],
        protectedPaths: ["CODEOWNERS"],
        budgetReservedUsd: 1,
        result: { outcome: "pull_request_opened", summary },
        ...data,
      },
    });
  }

  it("recordPullRequestDescription only updates when the expected hash matches (null for legacy)", async () => {
    const legacy = `container-desc-legacy-${randomUUID()}`;
    const recorded = `container-desc-recorded-${randomUUID()}`;
    const [h1, h2, h3] = ["1", "2", "3"].map((c) => c.repeat(64));
    try {
      await codingRunWith(legacy, "Legacy text.");
      await codingRunWith(recorded, "Root text.", { prDescriptionSha256: h1, prDescriptionRunId: recorded });
      const store = new PrismaContainerExecutionStore(db);
      const row = (runId: string) =>
        db.codingRun.findUniqueOrThrow({
          where: { runId },
          select: { prDescriptionSha256: true, prDescriptionRunId: true },
        });

      // A legacy row (no hash) only matches an expected null.
      await expect(
        store.recordPullRequestDescription({ rootRunId: legacy, expectedSha256: h1, sha256: h2, agentTextRunId: "x" }),
      ).resolves.toBe(false);
      await expect(row(legacy)).resolves.toEqual({ prDescriptionSha256: null, prDescriptionRunId: null });
      await expect(
        store.recordPullRequestDescription({
          rootRunId: legacy,
          expectedSha256: null,
          sha256: h2,
          agentTextRunId: "x",
        }),
      ).resolves.toBe(true);
      await expect(row(legacy)).resolves.toEqual({ prDescriptionSha256: h2, prDescriptionRunId: "x" });

      // A recorded row matches only its current hash; a stale expectation (a lost race) writes nothing.
      await expect(
        store.recordPullRequestDescription({
          rootRunId: recorded,
          expectedSha256: null,
          sha256: h2,
          agentTextRunId: "y",
        }),
      ).resolves.toBe(false);
      await expect(
        store.recordPullRequestDescription({
          rootRunId: recorded,
          expectedSha256: h1,
          sha256: h2,
          agentTextRunId: "y",
        }),
      ).resolves.toBe(true);
      await expect(
        store.recordPullRequestDescription({
          rootRunId: recorded,
          expectedSha256: h1,
          sha256: h3,
          agentTextRunId: "z",
        }),
      ).resolves.toBe(false);
      await expect(row(recorded)).resolves.toEqual({ prDescriptionSha256: h2, prDescriptionRunId: "y" });
    } finally {
      await db.codingRun.deleteMany({ where: { runId: { in: [legacy, recorded] } } });
      await db.run.deleteMany({ where: { id: { in: [legacy, recorded] } } });
    }
  });

  it("pullRequestMarkedReady reads whether the root's pull request was marked ready", async () => {
    const marked = `container-ready-marked-${randomUUID()}`;
    const draft = `container-ready-draft-${randomUUID()}`;
    try {
      await codingRunWith(marked, "Marked.", { markedReadyAt: new Date() });
      await codingRunWith(draft, "Draft.");
      const store = new PrismaContainerExecutionStore(db);
      await expect(store.pullRequestMarkedReady(marked)).resolves.toBe(true);
      await expect(store.pullRequestMarkedReady(draft)).resolves.toBe(false);
      await expect(store.pullRequestMarkedReady(`container-ready-missing-${randomUUID()}`)).resolves.toBe(false);
    } finally {
      await db.codingRun.deleteMany({ where: { runId: { in: [marked, draft] } } });
      await db.run.deleteMany({ where: { id: { in: [marked, draft] } } });
    }
  });

  it("pullRequestDescriptionBaseline reads the root's hash and the author run's stored summary", async () => {
    const root = `container-desc-root-${randomUUID()}`;
    const author = `container-desc-author-${randomUUID()}`;
    const legacy = `container-desc-legacy-${randomUUID()}`;
    const hash = "4".repeat(64);
    try {
      await codingRunWith(author, "Fix round text.");
      await codingRunWith(root, "Root text.", { prDescriptionSha256: hash, prDescriptionRunId: author });
      await codingRunWith(legacy, "Legacy text.");
      const store = new PrismaContainerExecutionStore(db);
      await expect(store.pullRequestDescriptionBaseline(root)).resolves.toEqual({
        recordedSha256: hash,
        previousAgentText: "Fix round text.",
        agentTextRunId: author,
      });
      await expect(store.pullRequestDescriptionBaseline(legacy)).resolves.toEqual({
        recordedSha256: null,
        previousAgentText: "Legacy text.",
        agentTextRunId: legacy,
        // What rebuilds the description the legacy root wrote.
        legacySource: {
          repository: "openai/example",
          baseRef: "main",
          headRef: `wardby/run-${legacy}`,
          summary: "Legacy text.",
          issueProvider: null,
          issueKey: null,
        },
      });
    } finally {
      await db.codingRun.deleteMany({ where: { runId: { in: [root, author, legacy] } } });
      await db.run.deleteMany({ where: { id: { in: [root, author, legacy] } } });
    }
  });

  it("pullRequestDescriptionBaseline's legacy source carries the root's stored tests, cache report and issue", async () => {
    const legacy = `container-desc-legacy-src-${randomUUID()}`;
    try {
      await codingRunWith(legacy, "Legacy text.", {
        result: {
          outcome: "pull_request_opened",
          summary: "Legacy text.",
          tests: [{ command: "npm test", outcome: "passed" }],
        },
        dependencyCacheResult: { projects: [{ path: ".", result: "hit" }] },
        issueProvider: "jira",
        issueKey: "ABC-12",
      });
      const store = new PrismaContainerExecutionStore(db);
      await expect(store.pullRequestDescriptionBaseline(legacy)).resolves.toMatchObject({
        legacySource: {
          summary: "Legacy text.",
          tests: [{ command: "npm test", outcome: "passed" }],
          dependencyCache: { projects: [{ path: ".", result: "hit" }] },
          issueProvider: "jira",
          issueKey: "ABC-12",
        },
      });
    } finally {
      await db.codingRun.deleteMany({ where: { runId: legacy } });
      await db.run.deleteMany({ where: { id: legacy } });
    }
  });

  it("linkedIssueSource returns the root's issue and the nearest mention status above it", async () => {
    const top = `container-issue-top-${randomUUID()}`;
    const middle = `container-issue-mid-${randomUUID()}`;
    const root = `container-issue-root-${randomUUID()}`;
    const bare = `container-issue-bare-${randomUUID()}`;
    try {
      await db.run.create({ data: { id: top, agentId, status: "succeeded" } });
      await db.runHostStatus.create({
        data: { runId: top, provider: "github", repository: "openai/example", number: 12, commentKind: "conversation" },
      });
      await db.run.create({ data: { id: middle, agentId, status: "succeeded", parentRunId: top } });
      await codingRunWith(root, "Root text.", { issueProvider: "jira", issueKey: "ABC-12" });
      await db.run.update({ where: { id: root }, data: { parentRunId: middle } });
      await codingRunWith(bare, "Bare text.");
      const store = new PrismaContainerExecutionStore(db);
      await expect(store.linkedIssueSource(root)).resolves.toEqual({
        issueProvider: "jira",
        issueKey: "ABC-12",
        hostStatus: { provider: "github", repository: "openai/example", number: 12, issueMention: false },
      });
      // A mention on the issue itself (its stored header) marks the status as an issue mention.
      await db.run.update({
        where: { id: top },
        data: { taskOverride: "[GitHub issue #12: Jokes]\nRepository: openai/example\nRequested by someone" },
      });
      await expect(store.linkedIssueSource(root)).resolves.toMatchObject({
        hostStatus: { provider: "github", repository: "openai/example", number: 12, issueMention: true },
      });
      await expect(store.linkedIssueSource(bare)).resolves.toEqual({
        issueProvider: null,
        issueKey: null,
        hostStatus: null,
      });
    } finally {
      await db.codingRun.deleteMany({ where: { runId: { in: [root, bare] } } });
      await db.runHostStatus.deleteMany({ where: { runId: top } });
      await db.run.deleteMany({ where: { id: { in: [root, bare] } } });
      await db.run.deleteMany({ where: { id: middle } });
      await db.run.deleteMany({ where: { id: top } });
    }
  });

  it("delegatingEventTask returns an event-started lead's task only to the run it delegated", async () => {
    const eventLead = `container-orig-event-${randomUUID()}`;
    const manualLead = `container-orig-manual-${randomUUID()}`;
    const delegated = `container-orig-child-${randomUUID()}`;
    const manualChild = `container-orig-mchild-${randomUUID()}`;
    const leadTask =
      "[GitHub issue #12]\nRepository: openai/example\nRequested by @someone\n\nRequest comment:\nAdd jokes";
    try {
      await db.run.create({ data: { id: eventLead, agentId, trigger: "host_event", taskOverride: leadTask } });
      await db.run.create({ data: { id: manualLead, agentId, trigger: "manual", taskOverride: leadTask } });
      await codingRunWith(delegated, "Child text.");
      await codingRunWith(manualChild, "Child text.");
      await db.run.update({ where: { id: delegated }, data: { trigger: "subagent", parentRunId: eventLead } });
      await db.run.update({ where: { id: manualChild }, data: { trigger: "subagent", parentRunId: manualLead } });
      const store = new PrismaContainerExecutionStore(db);
      await expect(store.delegatingEventTask(delegated)).resolves.toBe(leadTask);
      await expect(store.delegatingEventTask(manualChild)).resolves.toBeNull();
      // Not delegated (e.g. started by the event itself): nothing.
      await db.run.update({ where: { id: delegated }, data: { trigger: "host_event" } });
      await expect(store.delegatingEventTask(delegated)).resolves.toBeNull();
    } finally {
      await db.codingRun.deleteMany({ where: { runId: { in: [delegated, manualChild] } } });
      await db.run.deleteMany({ where: { id: { in: [delegated, manualChild] } } });
      await db.run.deleteMany({ where: { id: { in: [eventLead, manualLead] } } });
    }
  });

  it("pullRequestRunIds lists the root, then continuations that pushed, oldest first", async () => {
    const root = `container-desc-runs-root-${randomUUID()}`;
    const pushedLater = `container-desc-runs-b-${randomUUID()}`;
    const pushedEarlier = `container-desc-runs-a-${randomUUID()}`;
    const noChange = `container-desc-runs-c-${randomUUID()}`;
    const ids = [root, pushedLater, pushedEarlier, noChange];
    try {
      await codingRunWith(root, "Root text.");
      const continuation = async (runId: string, outcome: string, startedAt: Date) => {
        await codingRunWith(runId, "Round text.", {
          rootCodingRunId: root,
          result: { outcome, summary: "Round text." },
        });
        await db.run.update({ where: { id: runId }, data: { startedAt } });
      };
      // The root started last here: it is still listed first.
      await db.run.update({ where: { id: root }, data: { startedAt: new Date("2026-01-03T00:00:00Z") } });
      await continuation(pushedLater, "pull_request_updated", new Date("2026-01-02T00:00:00Z"));
      await continuation(pushedEarlier, "pull_request_updated", new Date("2026-01-01T00:00:00Z"));
      await continuation(noChange, "no_changes", new Date("2026-01-01T12:00:00Z"));
      const store = new PrismaContainerExecutionStore(db);
      await expect(store.pullRequestRunIds(root)).resolves.toEqual([root, pushedEarlier, pushedLater]);
    } finally {
      await db.codingRun.deleteMany({ where: { runId: { in: ids } } });
      await db.run.deleteMany({ where: { id: { in: ids } } });
    }
  });

  it("complete records the outcome on the run, and a fresh run's written hash on its own row", async () => {
    const fresh = `container-desc-fresh-${randomUUID()}`;
    const round = `container-desc-round-${randomUUID()}`;
    try {
      for (const runId of [fresh, round]) {
        await db.run.create({ data: { id: runId, agentId, executionManaged: true, status: "running" } });
        await db.codingRun.create({
          data: {
            runId,
            task: "Fix it.",
            repository: "openai/example",
            baseRef: "main",
            headRef: `wardby/run-${runId}`,
            provider: "codex",
            model: "gpt-5.6-luna",
            timeoutSec: 900,
            allowedEgress: [],
            protectedPaths: ["CODEOWNERS"],
            budgetReservedUsd: 1,
          },
        });
      }
      const store = new PrismaContainerExecutionStore(db);
      const result = (runId: string) => ({
        schemaVersion: 1 as const,
        outcome: "no_changes" as const,
        repository: "openai/example",
        baseRef: "main",
        headRef: `wardby/run-${runId}`,
        summary: "Done.",
        tests: [],
        usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      });
      const hash = "5".repeat(64);
      await store.complete(fresh, "succeeded", result(fresh), {
        prDescriptionOutcome: "written",
        prDescriptionSha256: hash,
        prDescriptionRunId: fresh,
      });
      await store.complete(round, "succeeded", result(round), { prDescriptionOutcome: "edited_by_hand" });
      const select = { prDescriptionSha256: true, prDescriptionRunId: true, prDescriptionOutcome: true };
      await expect(db.codingRun.findUniqueOrThrow({ where: { runId: fresh }, select })).resolves.toEqual({
        prDescriptionSha256: hash,
        prDescriptionRunId: fresh,
        prDescriptionOutcome: "written",
      });
      await expect(db.codingRun.findUniqueOrThrow({ where: { runId: round }, select })).resolves.toEqual({
        prDescriptionSha256: null,
        prDescriptionRunId: null,
        prDescriptionOutcome: "edited_by_hand",
      });
    } finally {
      await db.codingRun.deleteMany({ where: { runId: { in: [fresh, round] } } });
      await db.run.deleteMany({ where: { id: { in: [fresh, round] } } });
    }
  });

  describe("a run with several repositories (#537)", () => {
    const codingRunData = (runId: string) => ({
      runId,
      task: "Fix it.",
      repository: "openai/example",
      baseRef: "main",
      headRef: `wardby/run-${runId}`,
      provider: "codex",
      model: "gpt-5.6-luna",
      timeoutSec: 900,
      allowedEgress: [],
      protectedPaths: ["CODEOWNERS"],
      budgetReservedUsd: 1,
    });
    const opened = (repository: string, baseRef: string, n: number) => ({
      schemaVersion: 1 as const,
      outcome: "pull_request_opened" as const,
      repository,
      baseRef,
      headRef: "wardby/run-x",
      commitSha: "d".repeat(40),
      pullRequestNumber: n,
      pullRequestUrl: `https://github.com/${repository}/pull/${n}`,
      summary: `PR for ${repository}.`,
      tests: [],
      usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
    });
    async function seed(runId: string, names: string[]) {
      await db.run.create({ data: { id: runId, agentId, executionManaged: true, status: "running" } });
      await db.codingRun.create({ data: codingRunData(runId) });
      const rows = [];
      for (const [i, name] of names.entries()) {
        rows.push(
          await db.codingRunRepository.create({
            data: {
              runId,
              position: i + 1,
              name,
              access: "write",
              provider: "github",
              repository: `openai/${name}`,
              requestedRef: "develop",
              resolvedSha: "a".repeat(40),
              baseRef: "develop",
              headRef: `wardby/run-${runId}`,
            },
          }),
        );
      }
      return rows;
    }
    async function drop(runIds: string[]) {
      await db.codingRun.deleteMany({ where: { runId: { in: runIds } } });
      await db.run.deleteMany({ where: { id: { in: runIds } } });
    }

    it("completePartially records what published, on the run and each row, and ends the run failed", async () => {
      const runId = `container-partial-${randomUUID()}`;
      try {
        const [tools, docs] = await seed(runId, ["tools", "docs"]);
        const store = new PrismaContainerExecutionStore(db);
        const error = "partially_published: workspace: published; tools: published; docs: failed(workspace)";
        await store.completePartially(runId, {
          mainResult: opened("openai/example", "main", 42),
          record: { baseSha: "b".repeat(40), mergeOrder: 1 },
          extras: [
            {
              id: tools.id,
              name: "tools",
              result: opened("openai/tools", "develop", 7),
              pullRequestNumber: 7,
              resultBranch: null,
              baseSha: "c".repeat(40),
              mergeOrder: 2,
              prDescriptionOutcome: "written",
              prDescriptionSha256: "5".repeat(64),
              prDescriptionRunId: runId,
            },
          ],
          error,
          audit: { failureCategory: "partially_published", diagnosticId: "coding_diag_x" },
        });
        const run = await db.run.findUniqueOrThrow({ where: { id: runId }, include: { codingRun: true } });
        expect(run.status).toBe("failed");
        expect(run.error).toBe(error);
        expect(run.finishedAt).not.toBeNull();
        expect(run.codingRun).toMatchObject({
          result: expect.objectContaining({ pullRequestNumber: 42 }),
          baseSha: "b".repeat(40),
          mergeOrder: 1,
          failureCategory: "partially_published",
          diagnosticId: "coding_diag_x",
        });
        await expect(db.codingRunRepository.findUniqueOrThrow({ where: { id: tools.id } })).resolves.toMatchObject({
          result: expect.objectContaining({ repository: "openai/tools", pullRequestNumber: 7 }),
          pullRequestNumber: 7,
          baseSha: "c".repeat(40),
          mergeOrder: 2,
          prDescriptionOutcome: "written",
          prDescriptionSha256: "5".repeat(64),
          prDescriptionRunId: runId,
        });
        // A repository that failed records nothing.
        await expect(db.codingRunRepository.findUniqueOrThrow({ where: { id: docs.id } })).resolves.toMatchObject({
          result: null,
          pullRequestNumber: null,
          mergeOrder: null,
        });
        // A second write changes nothing: the run already ended.
        await store.completePartially(runId, {
          mainResult: null,
          record: {},
          extras: [],
          error: "partially_published: other",
          audit: { failureCategory: "partially_published", diagnosticId: "coding_diag_y" },
        });
        await expect(db.run.findUniqueOrThrow({ where: { id: runId } })).resolves.toMatchObject({ error });
      } finally {
        await drop([runId]);
      }
    });

    it("complete records each extra on its own row, never another run's", async () => {
      const runId = `container-extras-${randomUUID()}`;
      const other = `container-extras-other-${randomUUID()}`;
      try {
        const [tools] = await seed(runId, ["tools"]);
        const [otherTools] = await seed(other, ["tools"]);
        const store = new PrismaContainerExecutionStore(db);
        const record = (id: string) => ({
          id,
          name: "tools",
          result: opened("openai/tools", "develop", 7),
          pullRequestNumber: 7,
          resultBranch: null,
          baseSha: "c".repeat(40),
          mergeOrder: 2,
        });
        // The other run's row id, passed for this run: not written.
        await store.complete(runId, "succeeded", opened("openai/example", "main", 42), {}, [
          record(tools.id),
          record(otherTools.id),
        ]);
        await expect(db.codingRunRepository.findUniqueOrThrow({ where: { id: tools.id } })).resolves.toMatchObject({
          pullRequestNumber: 7,
          mergeOrder: 2,
        });
        await expect(db.codingRunRepository.findUniqueOrThrow({ where: { id: otherTools.id } })).resolves.toMatchObject(
          { pullRequestNumber: null, result: null },
        );
      } finally {
        await drop([runId, other]);
      }
    });

    it("reads and compare-and-sets an extra's description on the root's row of that name", async () => {
      const rootId = `container-extra-desc-${randomUUID()}`;
      try {
        const [tools] = await seed(rootId, ["tools"]);
        await db.codingRunRepository.update({
          where: { id: tools.id },
          data: { result: opened("openai/tools", "develop", 7), prDescriptionSha256: "1".repeat(64) },
        });
        const store = new PrismaContainerExecutionStore(db);
        await expect(store.pullRequestDescriptionBaseline(rootId, "tools")).resolves.toEqual({
          recordedSha256: "1".repeat(64),
          previousAgentText: "PR for openai/tools.",
          agentTextRunId: rootId,
        });
        const write = (expectedSha256: string) =>
          store.recordPullRequestDescription({
            rootRunId: rootId,
            expectedSha256,
            sha256: "2".repeat(64),
            agentTextRunId: rootId,
            name: "tools",
          });
        await expect(write("9".repeat(64))).resolves.toBe(false);
        await expect(write("1".repeat(64))).resolves.toBe(true);
        await expect(db.codingRunRepository.findUniqueOrThrow({ where: { id: tools.id } })).resolves.toMatchObject({
          prDescriptionSha256: "2".repeat(64),
        });
        // The run's own (default repository) hash is untouched.
        await expect(db.codingRun.findUniqueOrThrow({ where: { runId: rootId } })).resolves.toMatchObject({
          prDescriptionSha256: null,
        });
      } finally {
        await drop([rootId]);
      }
    });
  });
});
