import { describe, expect, it } from "vitest";
import { matchRoot, resolvePolicy } from "./allowlist.js";

describe("matchRoot", () => {
  const entries = [
    { name: "react", wildcard: false, range: "^19" },
    { name: "@heroui/", wildcard: true },
  ];
  it("matches exact names and scope wildcards", () => {
    expect(matchRoot(entries, "react")).toEqual(entries[0]);
    expect(matchRoot(entries, "@heroui/react")).toEqual(entries[1]);
    expect(matchRoot(entries, "@heroui")).toBeUndefined();
    expect(matchRoot(entries, "react-dom")).toBeUndefined();
  });
});

describe("resolvePolicy", () => {
  it("defaults to three days and bounds overrides", () => {
    expect(resolvePolicy(undefined)).toEqual({ minReleaseAgeDays: 3 });
    expect(resolvePolicy({ minReleaseAgeDays: 0 })).toEqual({ minReleaseAgeDays: 0 });
    expect(() => resolvePolicy({ minReleaseAgeDays: 31 })).toThrow();
    expect(() => resolvePolicy({ minReleaseAgeDays: 1.5 })).toThrow();
  });
});
