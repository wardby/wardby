/**
 * The builder's gate (spec §7) against real PostgreSQL: a plan set made by a planner the builder's
 * owner can execute is built only when every counted document is approved, from the approved
 * versions, redacted against the builder's secret values. Skipped without DATABASE_URL.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPrismaClient } from "../db.js";
import { MAX_CODING_TASK_BYTES } from "../../coding/protocol.js";
import { attachSecret, createSecret } from "../secrets.js";
import {
  planPullRequestLine,
  resolveBuildPlan,
  resolveRecordedBuildPlan,
  ticketTitles,
  type BuildPlan,
} from "./build.js";
import { createPlanSetFixture, setReviewState, type FixtureDocument } from "./build.test-support.js";
import { PlanRefusedError } from "./refusal.js";
import { planRefusedReply } from "./wording.js";

const FAKE_SECRET = "wardby-fake-build-secret-7c2d";

const PLAN_MD =
  "# Plan\n\nSee [api](api.md) and [screens](screens/).\n\n## Tickets\n### Ticket 1: Login\n### Ticket 2: Feed\n";
const SCREENS = {
  "manifest.json": '{"boards":[{"id":"home","title":"Home"}]}',
  "boards/home.html": "<main>Home</main>",
};

describe.skipIf(!process.env.DATABASE_URL)("resolveBuildPlan (database)", () => {
  const db = createPrismaClient();
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  const s = randomUUID().slice(0, 8);
  const repository = `o/r-${s}`;
  const owner = `build-owner-${s}`;
  const outsider = `build-outsider-${s}`;
  const agents: string[] = [];
  let n = 0;
  let planner: string;
  let builder: string;

  async function makeAgent(ownerId: string, profile: object): Promise<string> {
    const agent = await db.agent.create({
      data: {
        name: `build-${s}-${++n}`,
        systemPrompt: "p",
        model: "m",
        budgetUsd: 1,
        ownerId,
        kind: "coding",
        codingProfile: { create: { repository, protectedPaths: [], ...profile } },
      },
    });
    agents.push(agent.id);
    return agent.id;
  }

  const baseDocuments = (apiState = "in_review"): FixtureDocument[] => [
    { path: "plan.md", content: PLAN_MD, version: 3 },
    { path: "screens/", content: SCREENS, version: 2 },
    { path: "api.md", content: "# API\n\nGET /feed\n", version: 1, reviewState: apiState },
  ];
  /** A fresh plan set under its own number, so cases do not share state. */
  let nextNumber = 100;
  async function planSet(
    documents: FixtureDocument[],
    number = ++nextNumber,
    at: { repository?: string; plannerId?: string } = {},
  ) {
    const fixture = await createPlanSetFixture(db, {
      plannerId: at.plannerId ?? planner,
      ownerId: owner,
      repository: at.repository ?? repository,
      number,
      documents,
    });
    return { ...fixture, number };
  }
  const resolve = (
    number: number,
    extra: { ticket?: number; builderOwnerId?: string | null; agentId?: string; repository?: string } = {},
  ) =>
    resolveBuildPlan(db, cipher, {
      builderAgentId: extra.agentId ?? builder,
      builderOwnerId: extra.builderOwnerId === undefined ? owner : extra.builderOwnerId,
      repository: extra.repository ?? repository,
      number,
      ...(extra.ticket !== undefined ? { ticket: extra.ticket } : {}),
    });
  const ok = (plan: BuildPlan | null): BuildPlan => {
    if (!plan) throw new Error("expected a build plan");
    return plan;
  };

  beforeAll(async () => {
    await db.principal.create({ data: { id: owner, subject: owner } });
    await db.principal.create({ data: { id: outsider, subject: outsider } });
    planner = await makeAgent(owner, { planDocument: { store: "wardby", reviewers: [owner] } });
    builder = await makeAgent(owner, { buildFromPlan: true });
  });
  afterAll(async () => {
    await db.document.deleteMany({ where: { ownerId: owner } });
    await db.planSet.deleteMany({ where: { agentId: { in: agents } } });
    await db.agentSecret.deleteMany({ where: { agentId: { in: agents } } });
    await db.secret.deleteMany({ where: { ownerId: owner } });
    await db.agent.deleteMany({ where: { id: { in: agents } } });
    await db.principal.deleteMany({ where: { id: { in: [owner, outsider] } } });
    await db.$disconnect();
  });

  it("refuses with plan_not_approved, naming the documents still waiting", async () => {
    const { number } = await planSet(baseDocuments());
    const attempt = resolve(number);
    await expect(attempt).rejects.toBeInstanceOf(PlanRefusedError);
    await expect(attempt).rejects.toThrow(/^plan_not_approved: .*api\.md/);
  });

  it("gives the approved versions, the plan text wrapped with links into the plan folder, and every file", async () => {
    const { number, documentIds } = await planSet(baseDocuments());
    await setReviewState(db, documentIds["api.md"], "approved");
    const plan = ok(await resolve(number));
    expect(plan.number).toBe(number);
    expect(plan.versions).toEqual([
      { documentId: documentIds["plan.md"], path: "plan.md", kind: "document", versionNumber: 3 },
      { documentId: documentIds["api.md"], path: "api.md", kind: "document", versionNumber: 1 },
      { documentId: documentIds["screens/"], path: "screens/", kind: "design", versionNumber: 2 },
    ]);
    const wrapped = /<plan>\n([\s\S]*)\n<\/plan>/.exec(plan.taskSection);
    expect(wrapped).not.toBeNull();
    expect(wrapped![1]).toContain("# Plan");
    expect(wrapped![1]).toContain("[api](/tmp/wardby-plan/api.md)");
    expect(wrapped![1]).toContain("[screens](/tmp/wardby-plan/screens/)");
    expect(wrapped![1]).toContain("GET /feed");
    expect(plan.planInputFiles.map((f) => f.path).sort()).toEqual([
      "api.md",
      "plan.md",
      "screens/boards/home.html",
      "screens/manifest.json",
    ]);
    expect(plan.planInputFiles.find((f) => f.path === "plan.md")!.content).toBe(PLAN_MD);
  });

  it("neither counts nor gives a document removed from the plan", async () => {
    const { number } = await planSet([
      ...baseDocuments("approved"),
      { path: "old.md", content: "# Old\n", version: 4, reviewState: "in_review", removedFromPlan: true },
    ]);
    const plan = ok(await resolve(number));
    expect(plan.versions.map((v) => v.path)).not.toContain("old.md");
    expect(plan.planInputFiles.map((f) => f.path)).not.toContain("old.md");
    expect(plan.taskSection).not.toContain("# Old");
  });

  it("ignores a plan set whose planner the builder's owner cannot execute", async () => {
    const { number } = await planSet(baseDocuments());
    const outsiderBuilder = await makeAgent(outsider, { buildFromPlan: true });
    expect(await resolve(number, { builderOwnerId: outsider, agentId: outsiderBuilder })).toBeNull();
  });

  it("is null when the repository has no plan set under that number", async () => {
    expect(await resolve(99_999)).toBeNull();
  });

  it("redacts the builder's secret values from the task section and every file", async () => {
    const secretBuilder = await makeAgent(owner, { buildFromPlan: true });
    const name = `BUILD_SECRET_${s}`;
    await createSecret(name, FAKE_SECRET, owner, cipher, db);
    await attachSecret(secretBuilder, name, owner, db);
    const { number } = await planSet([
      { path: "plan.md", content: `# Plan\n\ntoken ${FAKE_SECRET}\n`, version: 3 },
      { path: "screens/", content: { ...SCREENS, "boards/home.html": `<p>${FAKE_SECRET}</p>` }, version: 2 },
    ]);
    const plan = ok(await resolve(number, { agentId: secretBuilder }));
    expect(plan.taskSection).not.toContain(FAKE_SECRET);
    expect(plan.taskSection).toContain("[REDACTED]");
    for (const file of plan.planInputFiles) expect(file.content).not.toContain(FAKE_SECRET);
    expect(plan.planInputFiles.find((f) => f.path === "plan.md")!.content).toContain("[REDACTED]");
    expect(plan.planInputFiles.find((f) => f.path === "screens/boards/home.html")!.content).toContain("[REDACTED]");
  });

  it("redacts the planner's secret values from the waiting paths of a refusal; without them, gives a count", async () => {
    const secretPlanner = await makeAgent(owner, { planDocument: { store: "wardby", reviewers: [owner] } });
    const name = `PLANNER_SECRET_${s}`;
    await createSecret(name, FAKE_SECRET, owner, cipher, db);
    await attachSecret(secretPlanner, name, owner, db);
    const { number } = await planSet(
      [
        { path: "plan.md", content: PLAN_MD, version: 1 },
        { path: `notes-${FAKE_SECRET}.md`, content: "# N\n", version: 1, reviewState: "in_review" },
      ],
      undefined,
      { plannerId: secretPlanner },
    );
    const refused = await resolve(number).catch((err: unknown) => err);
    expect(refused).toBeInstanceOf(PlanRefusedError);
    const err = refused as PlanRefusedError;
    expect(err.message).not.toContain(FAKE_SECRET);
    expect(err.waiting.join(" ")).not.toContain(FAKE_SECRET);
    expect(err.waiting).toEqual(["notes-[REDACTED].md"]);
    expect(planRefusedReply(err)).not.toContain(FAKE_SECRET);

    const unreadable = await resolveBuildPlan(db, undefined, {
      builderAgentId: builder,
      builderOwnerId: owner,
      repository,
      number,
    }).then(
      () => {
        throw new Error("expected a refusal");
      },
      (e: unknown) => e as PlanRefusedError,
    );
    expect(unreadable.message).toBe("plan_not_approved: still waiting: 1 document");
    expect(unreadable.waiting).toEqual([]);
  });

  it("refuses without a cipher: unredacted text never passes the gate", async () => {
    const { number } = await planSet(baseDocuments("approved"));
    const attempt = resolveBuildPlan(db, undefined, {
      builderAgentId: builder,
      builderOwnerId: owner,
      repository,
      number,
    });
    await expect(attempt).rejects.toThrow(/^plan_not_approved: secret values unavailable/);
  });

  it("refuses with plan_too_large when the plan does not fit the task", async () => {
    const { number } = await planSet([
      { path: "plan.md", content: `# Plan\n\n${"x".repeat(MAX_CODING_TASK_BYTES / 2)}\n`, version: 1 },
    ]);
    const attempt = resolve(number);
    await expect(attempt).rejects.toBeInstanceOf(PlanRefusedError);
    await expect(attempt).rejects.toThrow(/^plan_too_large:/);
  });

  it("names the ticket to build", async () => {
    const { number } = await planSet(baseDocuments("approved"));
    const plan = ok(await resolve(number, { ticket: 2 }));
    expect(
      plan.taskSection.startsWith(`Approved plan ${number}. Build exactly ticket 2 from this approved plan.`),
    ).toBe(true);
  });

  it("matches the plan set's repository the way the host does (case-insensitively, any accepted form)", async () => {
    const upper = `O/R-${s.toUpperCase()}-CASE`;
    const { number } = await planSet(baseDocuments(), undefined, { repository: upper });
    // The planner's set is recorded as O/R-…; the builder is linked as o/r-… (or a github.com URL).
    for (const asked of [upper.toLowerCase(), `https://github.com/${upper.toLowerCase()}`]) {
      await expect(resolve(number, { repository: asked })).rejects.toThrow(/^plan_not_approved: .*api\.md/);
    }
  });

  it("matches the repository exactly: `_`, `%` and `\\` are not wildcards", async () => {
    // A set for acme/my-repo never gates a builder on acme/my_repo (nor acme/my%repo).
    const dashed = await planSet(baseDocuments(), undefined, { repository: `acme-${s}/my-repo` });
    for (const asked of [`acme-${s}/my_repo`, `acme-${s}/my%repo`, `acme-${s}/my%`]) {
      expect(await resolve(dashed.number, { repository: asked })).toBeNull();
    }
    // A set whose name holds the characters still matches itself, in any case.
    const underscored = await planSet(baseDocuments(), undefined, { repository: `acme-${s}/My_Repo` });
    await expect(resolve(underscored.number, { repository: `acme-${s}/my_repo` })).rejects.toThrow(
      /^plan_not_approved: .*api\.md/,
    );
    const backslashed = await planSet(baseDocuments(), undefined, { repository: `local-${s}\\a_b%c` });
    await expect(resolve(backslashed.number, { repository: `LOCAL-${s}\\A_B%C` })).rejects.toThrow(
      /^plan_not_approved: .*api\.md/,
    );
    expect(await resolve(backslashed.number, { repository: `local-${s}\\axb%c` })).toBeNull();
  });

  it("builds from the newest of two visible plan sets for one repository and number", async () => {
    const otherPlanner = await makeAgent(owner, { planDocument: { store: "wardby", reviewers: [owner] } });
    const number = ++nextNumber;
    const older = await planSet(baseDocuments("approved"), number);
    const newer = await planSet([{ path: "plan.md", content: "# Newer plan\n", version: 7 }], number, {
      plannerId: otherPlanner,
    });
    await db.planSet.update({ where: { id: older.planSetId }, data: { createdAt: new Date(Date.UTC(2026, 0, 1)) } });
    await db.planSet.update({ where: { id: newer.planSetId }, data: { createdAt: new Date(Date.UTC(2026, 0, 2)) } });
    const plan = ok(await resolve(number));
    expect(plan.planSetId).toBe(newer.planSetId);
    expect(plan.versions.map((v) => `${v.path} v${v.versionNumber}`)).toEqual(["plan.md v7"]);
    // And the other way round: the older set's approval is not used once a newer one waits.
    await setReviewState(db, newer.documentIds["plan.md"], "in_review");
    await expect(resolve(number)).rejects.toThrow(/^plan_not_approved: still waiting: plan\.md/);
  });

  it("refuses an ownerless builder with plan_not_approved (fail closed)", async () => {
    const { number } = await planSet(baseDocuments("approved"));
    const attempt = resolve(number, { builderOwnerId: null });
    await expect(attempt).rejects.toBeInstanceOf(PlanRefusedError);
    await expect(attempt).rejects.toThrow(/^plan_not_approved: the builder has no owner/);
  });

  it("redacts a JSON-escaped secret in a design's manifest and an HTML-escaped one in a board", async () => {
    const secretBuilder = await makeAgent(owner, { buildFromPlan: true });
    // Values whose stored forms differ from the raw value: JSON escapes the quote and the backslash,
    // HTML escapes the angle bracket and the ampersand.
    const jsonSecret = `wardby-fake"json\\secret-${s}`;
    const htmlSecret = `wardby-fake<html&secret-${s}`;
    for (const [name, value] of [
      [`JSON_SECRET_${s}`, jsonSecret],
      [`HTML_SECRET_${s}`, htmlSecret],
    ]) {
      await createSecret(name, value, owner, cipher, db);
      await attachSecret(secretBuilder, name, owner, db);
    }
    const jsonEscaped = JSON.stringify(jsonSecret).slice(1, -1);
    const htmlEscaped = htmlSecret.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    expect(jsonEscaped).not.toBe(jsonSecret);
    expect(htmlEscaped).not.toBe(htmlSecret);
    const { number } = await planSet([
      { path: "plan.md", content: `# Plan\n\nkeys ${jsonEscaped} and ${htmlEscaped}\n`, version: 3 },
      {
        path: "screens/",
        content: {
          "manifest.json": JSON.stringify({ boards: [{ id: "home", title: jsonSecret }] }),
          "boards/home.html": `<main data-k="${htmlEscaped}">${htmlEscaped}</main>`,
        },
        version: 2,
      },
    ]);
    const plan = ok(await resolve(number, { agentId: secretBuilder }));
    const outputs = [plan.taskSection, ...plan.planInputFiles.map((f) => f.content)];
    for (const text of outputs) {
      for (const form of [jsonSecret, jsonEscaped, htmlSecret, htmlEscaped]) expect(text).not.toContain(form);
    }
    expect(plan.planInputFiles.find((f) => f.path === "screens/manifest.json")!.content).toContain("[REDACTED]");
    expect(plan.planInputFiles.find((f) => f.path === "screens/boards/home.html")!.content).toContain("[REDACTED]");
    expect(plan.taskSection).toContain("[REDACTED]");
  });

  it("rebuilds a recorded plan from exactly its versions, and refuses when one is gone", async () => {
    const { number, planSetId, documentIds } = await planSet(baseDocuments("approved"));
    const recorded = ok(await resolve(number, { ticket: 1 }));
    // The document is reopened and gets a new version: the recorded build still uses v1.
    await setReviewState(db, documentIds["api.md"], "in_review");
    const v2 = await db.documentVersion.create({
      data: {
        documentId: documentIds["api.md"],
        number: 2,
        format: "markdown",
        markdown: "# API\n\nPOST /feed (reopened)\n",
        contentHash: `v2-${s}`,
        via: "agent",
      },
    });
    await db.document.update({ where: { id: documentIds["api.md"] }, data: { currentVersionId: v2.id } });
    const again = await resolveRecordedBuildPlan(db, cipher, {
      builderAgentId: builder,
      planSetId,
      number,
      versions: recorded.versions,
      ticket: 1,
    });
    expect(again).toEqual(recorded);

    const attempt = resolveRecordedBuildPlan(db, cipher, {
      builderAgentId: builder,
      planSetId,
      number,
      versions: [
        ...recorded.versions,
        { documentId: documentIds["api.md"], path: "gone.md", kind: "document", versionNumber: 9 },
      ],
    });
    await expect(attempt).rejects.toThrow(/^plan_not_approved: approved version no longer available: gone\.md/);
  });

  it("cites the plan in a pull request line", () => {
    const versions: BuildPlan["versions"] = [
      { documentId: "a", path: "plan.md", kind: "document", versionNumber: 3 },
      { documentId: "b", path: "api.md", kind: "document", versionNumber: 1 },
      { documentId: "c", path: "screens/", kind: "design", versionNumber: 2 },
    ];
    expect(planPullRequestLine(12, versions)).toBe("Plan 12: plan.md v3, api.md v1, screens v2");

    // A path is shown as in a notice: its @-mention pings nobody, its URL and backticks do nothing.
    const line = planPullRequestLine(12, [
      { documentId: "d", path: "@octocat-notes.md", kind: "document", versionNumber: 1 },
      { documentId: "e", path: "see`https://example.com`/", kind: "design", versionNumber: 2 },
    ]);
    expect(line).toBe("Plan 12: @\u200boctocat-notes.md v1, seehttps\u200b://example.com v2");
    expect(line).not.toMatch(/@octocat/);
  });

  it("reads ticket titles from the Tickets section only", () => {
    expect(ticketTitles("## Tickets\n### Ticket 1: Login\n### Ticket 2: Feed\n## Other\n### Ticket 3: No")).toEqual(
      new Map([
        [1, "Login"],
        [2, "Feed"],
      ]),
    );
  });
});
