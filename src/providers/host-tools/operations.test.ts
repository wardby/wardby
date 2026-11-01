import { describe, expect, it } from "vitest";
import { HOST_OPERATIONS, isHostOperation, REQUIRED_OPERATIONS } from "./operations.js";

const PR = {
  number: 4,
  title: "t",
  body: "",
  author: "a",
  state: "open",
  merged: false,
  draft: false,
  baseRef: "main",
  headRef: "feature",
  headSha: "abc123",
  isFork: false,
  htmlUrl: "https://git.example.com/acme/web/pull/4",
};

describe("host operations", () => {
  it("requires the core the spec names, all known", () => {
    expect([...REQUIRED_OPERATIONS].sort()).toEqual(
      [
        "createComment",
        "findPullRequest",
        "getDiff",
        "getPullRequest",
        "listComments",
        "listFiles",
        "listPullRequestFiles",
        "openPullRequest",
        "readFile",
        "submitVerdict",
        "updatePullRequest",
      ].sort(),
    );
    for (const name of REQUIRED_OPERATIONS) expect(isHostOperation(name)).toBe(true);
  });

  it("does not treat an Object.prototype key as an operation", () => {
    expect(isHostOperation("constructor")).toBe(false);
    expect(isHostOperation("toString")).toBe(false);
  });

  it("marks reads read-only, with GET alone, and writes not", () => {
    for (const [name, op] of Object.entries(HOST_OPERATIONS)) {
      if (op.readOnly) expect(op.methods, name).toEqual(["GET"]);
      else expect(op.methods, name).not.toContain("GET");
    }
  });

  it("gives only the permission lookup the permission credential", () => {
    const permission = Object.entries(HOST_OPERATIONS).filter(([, op]) => op.credential === "permission");
    expect(permission.map(([name]) => name)).toEqual(["getRepositoryPermission"]);
  });

  it("validates a result, and refuses a wrong one", () => {
    expect(HOST_OPERATIONS.getPullRequest.result.safeParse(PR).success).toBe(true);
    expect(HOST_OPERATIONS.getPullRequest.result.safeParse({ ...PR, number: "4" }).success).toBe(false);
    expect(HOST_OPERATIONS.findPullRequest.result.safeParse({ pullRequest: null }).success).toBe(true);
    expect(HOST_OPERATIONS.getRepositoryPermission.result.safeParse({ permission: "owner" }).success).toBe(false);
    expect(HOST_OPERATIONS.getRepositoryPermission.result.safeParse({ permission: "write" }).success).toBe(true);
  });
});
