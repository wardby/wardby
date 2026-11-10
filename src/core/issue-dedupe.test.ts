import { describe, expect, it, vi } from "vitest";
import {
  BUSY_RESULT,
  dedupeLockKey,
  fileIssue,
  fingerprintHash,
  isLockTimeout,
  TRACKER_CALL_OPTIONS,
  type FileIssueInput,
} from "./issue-dedupe.js";
import { type IssueTracker, IssueTrackerError, type IssueView } from "../providers/issue-tracker/types.js";

interface Row {
  id: string;
  issueProvider: string;
  projectKey: string;
  fingerprintHash: string;
  issueKey: string;
  agentId: string;
  createdByRunId: string | null;
  seenCount: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

function fakeDb(rows: Row[] = []) {
  let n = rows.length;
  const tx = {
    $executeRaw: vi.fn(async (..._args: unknown[]) => 0),
    issueFingerprint: {
      findFirst: vi.fn(async ({ where }: any) => {
        const hits = rows.filter(
          (r) =>
            r.issueProvider === where.issueProvider &&
            r.projectKey === where.projectKey &&
            r.fingerprintHash === where.fingerprintHash,
        );
        return hits.sort((a, b) => b.firstSeenAt.getTime() - a.firstSeenAt.getTime())[0] ?? null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const row: Row = {
          id: `r${++n}`,
          seenCount: 1,
          firstSeenAt: new Date(Date.now() + n),
          lastSeenAt: new Date(),
          createdByRunId: null,
          ...data,
        };
        rows.push(row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      }),
    },
  };
  const db = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown, _opts?: unknown) => fn(tx)) };
  return { db: db as any, tx, rows };
}

function view(key: string, statusCategory: IssueView["statusCategory"], projectKey = "OPS"): IssueView {
  return {
    key,
    projectKey,
    summary: "s",
    description: "",
    descriptionTruncated: false,
    status: statusCategory === "done" ? "Done" : "Open",
    statusCategory,
    issueType: "Bug",
    priority: null,
    labels: [],
    assignee: null,
    reporter: null,
    url: `https://your-site.atlassian.net/browse/${key}`,
    comments: [],
    commentsTruncated: false,
    attachments: [],
    links: [],
  };
}

function fakeTracker(over: Partial<IssueTracker> = {}): IssueTracker {
  let next = 100;
  return {
    provider: "jira",
    botAccountId: vi.fn(),
    identity: vi.fn(),
    getIssue: vi.fn(async (key: string) => view(key, "new")),
    snapshotIssue: vi.fn(),
    issueProject: vi.fn(),
    search: vi.fn(),
    matchesJql: vi.fn(),
    comment: vi.fn(async () => ({ id: "c1", url: "u" })),
    editComment: vi.fn(),
    readComment: vi.fn(),
    issueUrl: (k: string) => `https://your-site.atlassian.net/browse/${k}`,
    transitions: vi.fn(),
    transitionTo: vi.fn(),
    editableFields: vi.fn(),
    editFields: vi.fn(),
    linkTypes: vi.fn(async () => [
      { name: "Blocks", inward: "is blocked by", outward: "blocks" },
      { name: "Relates", inward: "relates to", outward: "relates to" },
    ]),
    linkIssues: vi.fn(async () => undefined),
    addRemoteLink: vi.fn(),
    getProperty: vi.fn(),
    setProperty: vi.fn(),
    createMeta: vi.fn(),
    fieldMeta: vi.fn(),
    createIssue: vi.fn(async () => {
      const key = `OPS-${next++}`;
      return { key, url: `https://your-site.atlassian.net/browse/${key}` };
    }),
    readAttachmentText: vi.fn(),
    ...over,
  };
}

const FP = "checkout:TypeError:cart.ts:42";
const link = { provider: "jira", projectKey: "OPS", access: "write" };

function input(tracker: IssueTracker, over: Partial<FileIssueInput> = {}): FileIssueInput {
  return {
    agentId: "a1",
    runId: "run1",
    link,
    tracker,
    fingerprint: FP,
    create: { issueType: "Bug", summary: "Checkout crash", descriptionMarkdown: "It broke." },
    seenAgainMarkdown: "Seen in run run2.",
    ...over,
  };
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: "old",
    issueProvider: "jira",
    projectKey: "OPS",
    fingerprintHash: fingerprintHash(FP),
    issueKey: "OPS-1",
    agentId: "a1",
    createdByRunId: "run0",
    seenCount: 2,
    firstSeenAt: new Date("2026-09-01"),
    lastSeenAt: new Date("2026-09-02"),
    ...over,
  };
}

describe("fingerprintHash / dedupeLockKey", () => {
  it("hashes to sha256 hex and a stable signed 64-bit key", () => {
    expect(fingerprintHash("x")).toMatch(/^[0-9a-f]{64}$/);
    const key = dedupeLockKey("jira", "OPS", fingerprintHash(FP));
    expect(key).toBe(dedupeLockKey("jira", "OPS", fingerprintHash(FP)));
    expect(key).not.toBe(dedupeLockKey("jira", "WEB", fingerprintHash(FP)));
    expect(key >= -(2n ** 63n) && key < 2n ** 63n).toBe(true);
  });
  it("ignores case, punctuation and spacing, but not letters or digits", () => {
    const base = fingerprintHash("checkout-api:NullPointerException:CartService.total");
    expect(fingerprintHash("checkoutapi:NullPointerException:CartService.total")).toBe(base);
    expect(fingerprintHash("Checkout API | nullpointerexception | cartservice total")).toBe(base);
    expect(fingerprintHash("checkout-api:NullPointerException:CartService.totals")).not.toBe(base);
    expect(fingerprintHash("Ünïcode-Ä")).toBe(fingerprintHash("ünïcodeä"));
  });
  it("rejects a fingerprint with no letters or digits, without touching the tracker", async () => {
    const { db } = fakeDb([]);
    const tracker = fakeTracker();
    const res = await fileIssue({ db }, input(tracker, { fingerprint: "--- :: ---" }));
    expect(res).toMatchObject({ error: "invalid_arguments" });
    expect(tracker.createIssue).not.toHaveBeenCalled();
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe("fileIssue", () => {
  it("creates without a fingerprint, with no row and no lock", async () => {
    const { db, rows } = fakeDb();
    const tracker = fakeTracker();
    const res = await fileIssue({ db }, input(tracker, { fingerprint: undefined }));
    expect(res).toEqual({ outcome: "created", issueKey: "OPS-100", url: expect.any(String), seenCount: 1 });
    expect(tracker.createIssue).toHaveBeenCalledWith(expect.objectContaining({ projectKey: "OPS" }));
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(rows).toHaveLength(0);
  });

  it("creates and records the hash (never the raw fingerprint) on first sight, under the lock", async () => {
    const { db, tx, rows } = fakeDb();
    const tracker = fakeTracker();
    const res = await fileIssue({ db }, input(tracker));
    expect(res).toMatchObject({ outcome: "created", issueKey: "OPS-100", seenCount: 1 });
    // lock_timeout first, then the advisory lock on this fingerprint's key.
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(tx.$executeRaw.mock.calls[0][0]).toEqual(
      expect.arrayContaining([expect.stringContaining("set_config('lock_timeout'")]),
    );
    expect(tx.$executeRaw.mock.calls[0][1]).toBe("5000ms");
    expect(tx.$executeRaw.mock.calls[1][0]).toEqual(
      expect.arrayContaining([expect.stringContaining("pg_advisory_xact_lock(")]),
    );
    expect(tx.$executeRaw.mock.calls[1][1]).toBe(dedupeLockKey("jira", "OPS", fingerprintHash(FP)));
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ timeout: 90_000 }));
    expect(rows).toEqual([
      expect.objectContaining({
        fingerprintHash: fingerprintHash(FP),
        issueKey: "OPS-100",
        agentId: "a1",
        createdByRunId: "run1",
      }),
    ]);
    const sent = JSON.stringify((tracker.createIssue as any).mock.calls);
    expect(sent).not.toContain(FP);
  });

  it("comments on an open match and increments the count", async () => {
    const { db, rows } = fakeDb([row()]);
    const tracker = fakeTracker();
    const res = await fileIssue({ db }, input(tracker, { link: { ...link, commentVisibilityRole: "Developers" } }));
    expect(res).toMatchObject({ outcome: "seen_again", issueKey: "OPS-1", seenCount: 3 });
    expect(tracker.createIssue).not.toHaveBeenCalled();
    expect(tracker.comment).toHaveBeenCalledWith(
      "OPS-1",
      { markdown: "Seen in run run2.\n\nSeen again (×3)", visibilityRole: "Developers" },
      TRACKER_CALL_OPTIONS,
    );
    expect(rows[0].seenCount).toBe(3);
    expect(rows[0].lastSeenAt.getTime()).toBeGreaterThan(new Date("2026-09-02").getTime());
  });

  it("keeps the footer as the last line, below the regression line", async () => {
    const { db } = fakeDb([row()]);
    const tracker = fakeTracker({ getIssue: vi.fn(async (k: string) => view(k, "done")) });
    await fileIssue({ db }, input(tracker, { footerMarkdown: "_wardby agent a1_" }));
    expect(tracker.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        descriptionMarkdown:
          "It broke.\n\nRegression of https://your-site.atlassian.net/browse/OPS-1\n\n_wardby agent a1_",
      }),
      TRACKER_CALL_OPTIONS,
    );
  });

  it("files a regression for a Done match: new issue relates to the old, old untouched", async () => {
    const { db, rows } = fakeDb([row()]);
    const tracker = fakeTracker({ getIssue: vi.fn(async (k: string) => view(k, "done")) });
    const res = await fileIssue({ db }, input(tracker));
    expect(res).toMatchObject({ outcome: "regression", issueKey: "OPS-100", seenCount: 1 });
    expect(tracker.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        descriptionMarkdown: "It broke.\n\nRegression of https://your-site.atlassian.net/browse/OPS-1",
      }),

      TRACKER_CALL_OPTIONS,
    );
    expect(tracker.linkIssues).toHaveBeenCalledWith(
      { type: "Relates", inwardKey: "OPS-1", outwardKey: "OPS-100" },
      TRACKER_CALL_OPTIONS,
    );
    expect(tracker.comment).not.toHaveBeenCalled();
    expect(rows[0].seenCount).toBe(2);
    expect(rows).toHaveLength(2);

    // The regression is now the latest: the next sighting comments on it.
    (tracker.getIssue as any).mockImplementation(async (k: string) => view(k, k === "OPS-1" ? "done" : "new"));
    const again = await fileIssue({ db }, input(tracker));
    expect(again).toMatchObject({ outcome: "seen_again", issueKey: "OPS-100", seenCount: 2 });
  });

  describe("createAllowed: false (caller at its creation cap)", () => {
    const CAP = { error: "issue_cap_reached", message: expect.stringMatching(/OPS/) };

    it("still records a seen-again update on an open match", async () => {
      const { db, rows } = fakeDb([row()]);
      const tracker = fakeTracker();
      expect(await fileIssue({ db }, input(tracker, { createAllowed: false }))).toMatchObject({
        outcome: "seen_again",
        issueKey: "OPS-1",
        seenCount: 3,
      });
      expect(tracker.comment).toHaveBeenCalledTimes(1);
      expect(rows[0].seenCount).toBe(3);
      expect(tracker.createIssue).not.toHaveBeenCalled();
    });

    it("refuses without creating when there is no match", async () => {
      const { db, rows } = fakeDb();
      const tracker = fakeTracker();
      expect(await fileIssue({ db }, input(tracker, { createAllowed: false }))).toEqual(CAP);
      expect(tracker.createIssue).not.toHaveBeenCalled();
      expect(rows).toHaveLength(0);
    });

    it("refuses without filing a regression for a Done match", async () => {
      const { db, rows } = fakeDb([row()]);
      const tracker = fakeTracker({ getIssue: vi.fn(async (k: string) => view(k, "done")) });
      expect(await fileIssue({ db }, input(tracker, { createAllowed: false }))).toEqual(CAP);
      expect(tracker.createIssue).not.toHaveBeenCalled();
      expect(tracker.linkIssues).not.toHaveBeenCalled();
      expect(tracker.comment).not.toHaveBeenCalled();
      expect(rows).toHaveLength(1);
      expect(rows[0].seenCount).toBe(2);
    });

    it("refuses without a fingerprint", async () => {
      const { db } = fakeDb();
      const tracker = fakeTracker();
      expect(await fileIssue({ db }, input(tracker, { createAllowed: false, fingerprint: null }))).toEqual(CAP);
      expect(tracker.createIssue).not.toHaveBeenCalled();
      expect(db.$transaction).not.toHaveBeenCalled();
    });
  });

  it("matches a link type named relates case-insensitively", async () => {
    const { db } = fakeDb([row()]);
    const tracker = fakeTracker({
      getIssue: vi.fn(async (k: string) => view(k, "done")),
      linkTypes: vi.fn(async () => [{ name: "RELATES", inward: "relates to", outward: "relates to" }]),
    });
    await fileIssue({ db }, input(tracker));
    expect(tracker.linkIssues).toHaveBeenCalledWith(expect.objectContaining({ type: "RELATES" }), TRACKER_CALL_OPTIONS);
  });

  it("skips the link when there is no Relates type, still naming the old issue", async () => {
    const { db } = fakeDb([row()]);
    const tracker = fakeTracker({
      getIssue: vi.fn(async (k: string) => view(k, "done")),
      linkTypes: vi.fn(async () => [{ name: "Blocks", inward: "is blocked by", outward: "blocks" }]),
    });
    const res = await fileIssue({ db }, input(tracker));
    expect(res).toMatchObject({ outcome: "regression" });
    expect(tracker.linkIssues).not.toHaveBeenCalled();
    expect(tracker.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        descriptionMarkdown: expect.stringContaining("Regression of https://your-site.atlassian.net/browse/OPS-1"),
      }),

      TRACKER_CALL_OPTIONS,
    );
  });

  it("still reports the regression when linking fails", async () => {
    const { db } = fakeDb([row()]);
    const tracker = fakeTracker({
      getIssue: vi.fn(async (k: string) => view(k, "done")),
      linkIssues: vi.fn(async () => {
        throw new IssueTrackerError("tracker_permission_denied");
      }),
    });
    expect(await fileIssue({ db }, input(tracker))).toMatchObject({ outcome: "regression", issueKey: "OPS-100" });
  });

  it("treats a deleted earlier issue as no match", async () => {
    const { db } = fakeDb([row()]);
    const tracker = fakeTracker({
      getIssue: vi.fn(async () => {
        throw new IssueTrackerError("tracker_not_found");
      }),
    });
    const res = await fileIssue({ db }, input(tracker));
    expect(res).toMatchObject({ outcome: "created", issueKey: "OPS-100" });
    expect(tracker.linkIssues).not.toHaveBeenCalled();
    expect((tracker.createIssue as any).mock.calls[0][0].descriptionMarkdown).toBe("It broke.");
  });

  it("treats an earlier issue that moved out of the project as no match", async () => {
    const { db } = fakeDb([row()]);
    const tracker = fakeTracker({ getIssue: vi.fn(async () => view("OTHER-9", "new", "OTHER")) });
    const res = await fileIssue({ db }, input(tracker));
    expect(res).toMatchObject({ outcome: "created" });
    expect(tracker.comment).not.toHaveBeenCalled();
  });

  it("only matches rows in the same project", async () => {
    const { db } = fakeDb([row({ projectKey: "WEB", issueKey: "WEB-1" })]);
    const tracker = fakeTracker();
    expect(await fileIssue({ db }, input(tracker))).toMatchObject({ outcome: "created" });
    expect(tracker.getIssue).not.toHaveBeenCalled();
  });

  it("refuses without a write link", async () => {
    const { db } = fakeDb();
    const tracker = fakeTracker();
    const res = await fileIssue({ db }, input(tracker, { link: { ...link, access: "read" } }));
    expect(res).toMatchObject({ error: "permission_denied" });
    expect(tracker.createIssue).not.toHaveBeenCalled();
  });

  it("rejects an empty or over-long fingerprint", async () => {
    const { db } = fakeDb();
    const tracker = fakeTracker();
    expect(await fileIssue({ db }, input(tracker, { fingerprint: "" }))).toMatchObject({ error: "invalid_arguments" });
    expect(await fileIssue({ db }, input(tracker, { fingerprint: "x".repeat(201) }))).toMatchObject({
      error: "invalid_arguments",
    });
    expect(tracker.createIssue).not.toHaveBeenCalled();
  });

  it("never throws: tracker and database errors come back as results", async () => {
    const tracker = fakeTracker({
      createIssue: vi.fn(async () => {
        throw new IssueTrackerError("tracker_invalid_request", "Missing required field: Component.");
      }),
    });
    expect(await fileIssue({ db: fakeDb().db }, input(tracker))).toEqual({
      error: "tracker_invalid_request",
      message: "Missing required field: Component.",
    });
    const broken = {
      $transaction: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    };
    expect(await fileIssue({ db: broken as any }, input(fakeTracker()))).toEqual({
      error: "internal_error",
      message: "Filing the issue failed.",
    });
  });
  it("passes the bounded call options to every tracker call in and after the critical section", async () => {
    const { db } = fakeDb([row()]);
    const tracker = fakeTracker({ getIssue: vi.fn(async (k: string) => view(k, "done")) });
    await fileIssue({ db }, input(tracker));
    expect(TRACKER_CALL_OPTIONS).toEqual({ timeoutMs: 30_000, retryOn429: false });
    expect(tracker.getIssue).toHaveBeenCalledWith("OPS-1", expect.objectContaining(TRACKER_CALL_OPTIONS));
    expect((tracker.createIssue as any).mock.calls[0][1]).toEqual(TRACKER_CALL_OPTIONS);
    expect(tracker.linkTypes).toHaveBeenCalledWith(TRACKER_CALL_OPTIONS);
    expect((tracker.linkIssues as any).mock.calls[0][1]).toEqual(TRACKER_CALL_OPTIONS);

    const open = fakeDb([row()]);
    const t2 = fakeTracker();
    await fileIssue({ db: open.db }, input(t2));
    expect((t2.comment as any).mock.calls[0][2]).toEqual(TRACKER_CALL_OPTIONS);
  });

  it("links the regression only after the transaction has committed", async () => {
    const { db } = fakeDb([row()]);
    const order: string[] = [];
    const inner = db.$transaction.getMockImplementation();
    db.$transaction.mockImplementation(async (fn: any, opts: any) => {
      const r = await inner(fn, opts);
      order.push("commit");
      return r;
    });
    const tracker = fakeTracker({
      getIssue: vi.fn(async (k: string) => view(k, "done")),
      linkIssues: vi.fn(async () => void order.push("link")),
    });
    await fileIssue({ db }, input(tracker));
    expect(order).toEqual(["commit", "link"]);
  });

  it("returns the error when the seen-again comment fails, and leaves the count alone", async () => {
    const { db, rows } = fakeDb([row()]);
    const tracker = fakeTracker({
      comment: vi.fn(async () => {
        throw new IssueTrackerError("tracker_rate_limited", "Jira is rate limiting requests.");
      }),
    });
    expect(await fileIssue({ db }, input(tracker))).toEqual({
      error: "tracker_rate_limited",
      message: "Jira is rate limiting requests.",
    });
    expect(rows[0].seenCount).toBe(2);
    expect(tracker.createIssue).not.toHaveBeenCalled();
  });

  it("returns the error, without creating, when the earlier issue cannot be read for another reason", async () => {
    const { db, rows } = fakeDb([row()]);
    const tracker = fakeTracker({
      getIssue: vi.fn(async () => {
        throw new IssueTrackerError("tracker_api_error", "The Jira call timed out.");
      }),
    });
    expect(await fileIssue({ db }, input(tracker))).toMatchObject({ error: "tracker_api_error" });
    expect(tracker.createIssue).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
  });

  it("answers busy when the advisory lock wait times out", async () => {
    const { db, tx } = fakeDb();
    tx.$executeRaw.mockImplementation(async (strings: unknown) => {
      if (String(strings).includes("pg_advisory_xact_lock")) {
        throw Object.assign(new Error("canceling statement due to lock timeout"), { code: "P2010" });
      }
      return 0;
    });
    const tracker = fakeTracker();
    expect(await fileIssue({ db }, input(tracker))).toEqual(BUSY_RESULT);
    expect(tracker.createIssue).not.toHaveBeenCalled();
  });

  it("recognises lock_not_available however it is wrapped", () => {
    expect(isLockTimeout({ code: "55P03" })).toBe(true);
    expect(isLockTimeout({ meta: { driverAdapterError: { cause: { originalCode: "55P03" } } } })).toBe(true);
    expect(isLockTimeout(new Error("x", { cause: { code: "55P03" } }))).toBe(true);
    expect(isLockTimeout(new Error("connection refused"))).toBe(false);
  });

  it("reports a completed create when the row write fails (no error, so no duplicate on retry)", async () => {
    for (const done of [false, true]) {
      const { db, tx } = fakeDb(done ? [row()] : []);
      tx.issueFingerprint.create.mockRejectedValueOnce(new Error("Transaction already closed"));
      const tracker = fakeTracker({ getIssue: vi.fn(async (k: string) => view(k, "done")) });
      const res = await fileIssue({ db }, input(tracker));
      expect(res).toEqual({
        outcome: done ? "regression" : "created",
        issueKey: "OPS-100",
        url: expect.any(String),
        seenCount: 1,
      });
      if (done)
        expect(tracker.linkIssues).toHaveBeenCalledWith(
          expect.objectContaining({ outwardKey: "OPS-100" }),
          TRACKER_CALL_OPTIONS,
        );
    }
  });

  it("reports a posted seen-again comment when the count update fails", async () => {
    const { db, tx } = fakeDb([row()]);
    tx.issueFingerprint.update.mockRejectedValueOnce(new Error("Transaction already closed"));
    const tracker = fakeTracker();
    expect(await fileIssue({ db }, input(tracker))).toMatchObject({
      outcome: "seen_again",
      issueKey: "OPS-1",
      seenCount: 3,
    });
  });
});
