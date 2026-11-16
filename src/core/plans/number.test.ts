import { describe, expect, it } from "vitest";
import { planNumberFromIssueKey } from "./number.js";

describe("planNumberFromIssueKey", () => {
  it("reads GitHub and Jira keys", () => {
    expect(planNumberFromIssueKey("github", "wardby/mobile#12")).toBe(12);
    expect(planNumberFromIssueKey("jira", "MOB-345")).toBe(345);
  });
  it("has none for anything else, or past the Int column", () => {
    expect(planNumberFromIssueKey("jira", "MOB-2147483648")).toBeUndefined();
    expect(planNumberFromIssueKey("jira", "MOB-2147483647")).toBe(2147483647);
    expect(planNumberFromIssueKey(null, null)).toBeUndefined();
    expect(planNumberFromIssueKey("github", "wardby/mobile")).toBeUndefined();
    expect(planNumberFromIssueKey("jira", "mob-1")).toBeUndefined();
    expect(planNumberFromIssueKey("other", "X-1")).toBeUndefined();
  });
});
