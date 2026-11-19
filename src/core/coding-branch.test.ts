import { describe, expect, it } from "vitest";
import { isWardbyHeadRef } from "../coding/protocol.js";
import { branchComponent, chooseHeadRef, isRepeatOf, namedHeadRefBase } from "./coding-branch.js";

type Row = { repository: string; headRef: string; status?: string; outcome?: string };

/** A transaction whose codingRun table holds the given rows (default: a finished run that opened a PR). */
function fakeTx(rows: Row[]) {
  const locks: unknown[] = [];
  const tx = {
    $queryRaw: async (...args: unknown[]) => {
      locks.push(args);
      return [{ locked: 1 }];
    },
    codingRun: {
      findMany: async ({ where }: { where: { repository: string; headRef: { startsWith: string } } }) =>
        rows
          .filter((r) => r.repository === where.repository && r.headRef.startsWith(where.headRef.startsWith))
          .map((r) => ({
            headRef: r.headRef,
            run: { status: r.status ?? "succeeded" },
            result: { outcome: r.outcome ?? "pull_request_opened", pullRequestNumber: 1 },
          })),
    },
  };
  return { tx: tx as unknown as Parameters<typeof chooseHeadRef>[0], locks };
}

describe("branchComponent", () => {
  it("keeps a Jira key intact, including its case", () => {
    expect(branchComponent("DEVXP-4012")).toBe("DEVXP-4012");
  });

  it("turns a GitHub issue reference into one safe component", () => {
    expect(branchComponent("your-org/your-repo#12")).toBe("your-org-your-repo-12");
  });

  it("lowercases and slugs a caller's name on request", () => {
    expect(branchComponent("Fix Invoice  Rounding!", { lowercase: true })).toBe("fix-invoice-rounding");
  });

  it("caps the length without leaving a trailing hyphen", () => {
    expect(branchComponent("a".repeat(39) + " tail", { lowercase: true })).toBe("a".repeat(39));
    expect(branchComponent("x".repeat(100))?.length).toBe(40);
  });

  it("returns undefined when nothing usable is left", () => {
    expect(branchComponent(undefined)).toBeUndefined();
    expect(branchComponent("")).toBeUndefined();
    expect(branchComponent("../../")).toBeUndefined();
  });
});

describe("namedHeadRefBase", () => {
  it("is the caller's name, else the issue key, else undefined", () => {
    expect(namedHeadRefBase({ requestedName: "Readme Test", issueKey: "DEVXP-1" })).toBe("wardby/readme-test");
    expect(namedHeadRefBase({ requestedName: "wardby/readme" })).toBe("wardby/readme");
    expect(namedHeadRefBase({ requestedName: "readme" })).toBe("wardby/readme");
    expect(namedHeadRefBase({ issueKey: "DEVXP-1" })).toBe("wardby/DEVXP-1");
    expect(namedHeadRefBase({})).toBeUndefined();
  });
});

describe("isRepeatOf", () => {
  it("matches the name and its numbered repeats only", () => {
    expect(isRepeatOf("wardby/DEVXP-1", "wardby/DEVXP-1")).toBe(true);
    expect(isRepeatOf("wardby/DEVXP-1", "wardby/DEVXP-1-2")).toBe(true);
    expect(isRepeatOf("wardby/DEVXP-1", "wardby/DEVXP-12")).toBe(false);
    expect(isRepeatOf("wardby/DEVXP-1", "wardby/DEVXP-1-x")).toBe(false);
  });
});

describe("chooseHeadRef", () => {
  const repository = "github:your-org/your-repo";

  it("prefers the caller's name, then the issue key, then the run id", async () => {
    const { tx } = fakeTx([]);
    const both = { repository, runId: "r1", issueKey: "DEVXP-4012" };
    expect(await chooseHeadRef(tx, { ...both, requestedName: "Invoice Rounding" })).toBe("wardby/invoice-rounding");
    expect(await chooseHeadRef(tx, both)).toBe("wardby/DEVXP-4012");
    expect(await chooseHeadRef(tx, { repository, runId: "r1" })).toBe("wardby/run-r1");
  });

  it("uses the run id without a lock or a lookup when nothing names the branch", async () => {
    const { tx, locks } = fakeTx([{ repository, headRef: "wardby/run-r1" }]);
    expect(await chooseHeadRef(tx, { repository, runId: "r1" })).toBe("wardby/run-r1");
    expect(locks).toHaveLength(0);
  });

  it("numbers repeat runs on a ticket in the same repository", async () => {
    const rows = [{ repository, headRef: "wardby/DEVXP-4012" }];
    expect(await chooseHeadRef(fakeTx(rows).tx, { repository, runId: "r2", issueKey: "DEVXP-4012" })).toBe(
      "wardby/DEVXP-4012-2",
    );
    rows.push({ repository, headRef: "wardby/DEVXP-4012-2" });
    expect(await chooseHeadRef(fakeTx(rows).tx, { repository, runId: "r3", issueKey: "DEVXP-4012" })).toBe(
      "wardby/DEVXP-4012-3",
    );
  });

  it("frees the name of a run that never pushed, but not one still going or one that did", async () => {
    const failed = { repository, headRef: "wardby/DEVXP-4012", status: "failed", outcome: "no_changes" };
    expect(await chooseHeadRef(fakeTx([failed]).tx, { repository, runId: "r2", issueKey: "DEVXP-4012" })).toBe(
      "wardby/DEVXP-4012",
    );
    const going = { repository, headRef: "wardby/DEVXP-4012", status: "running" };
    expect(await chooseHeadRef(fakeTx([going]).tx, { repository, runId: "r2", issueKey: "DEVXP-4012" })).toBe(
      "wardby/DEVXP-4012-2",
    );
    const pushed = { repository, headRef: "wardby/DEVXP-4012", outcome: "branch_pushed" };
    expect(await chooseHeadRef(fakeTx([pushed]).tx, { repository, runId: "r2", issueKey: "DEVXP-4012" })).toBe(
      "wardby/DEVXP-4012-2",
    );
  });

  it("does not count a longer ticket key or another repository as a clash", async () => {
    const rows = [
      { repository, headRef: "wardby/DEVXP-40123" },
      { repository: "github:your-org/other-repo", headRef: "wardby/DEVXP-4012" },
    ];
    expect(await chooseHeadRef(fakeTx(rows).tx, { repository, runId: "r1", issueKey: "DEVXP-4012" })).toBe(
      "wardby/DEVXP-4012",
    );
  });

  it("takes an advisory lock on the repository and name before it looks", async () => {
    const { tx, locks } = fakeTx([]);
    await chooseHeadRef(tx, { repository, runId: "r1", issueKey: "DEVXP-4012" });
    expect(locks).toHaveLength(1);
    expect(JSON.stringify(locks)).toContain(`wardby-coding-branch:${repository}:wardby/DEVXP-4012`);
  });

  it("stops after 99 repeats", async () => {
    const rows = [{ repository, headRef: "wardby/DEVXP-4012" }];
    for (let n = 2; n <= 99; n++) rows.push({ repository, headRef: `wardby/DEVXP-4012-${n}` });
    await expect(chooseHeadRef(fakeTx(rows).tx, { repository, runId: "r1", issueKey: "DEVXP-4012" })).rejects.toThrow(
      "coding_branch_names_exhausted",
    );
  });

  it("never returns a name the worker input would refuse", async () => {
    const { tx } = fakeTx([]);
    for (const issueKey of ["DEVXP-4012", "your-org/your-repo#12", "x".repeat(200)]) {
      expect(isWardbyHeadRef(await chooseHeadRef(tx, { repository, runId: "r1", issueKey }))).toBe(true);
    }
  });
});
