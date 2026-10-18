import { describe, expect, it } from "vitest";
import { issueReference } from "./types.js";

describe("issueReference", () => {
  const jiraUrl = (key: string) => `https://example.atlassian.net/browse/${key}`;

  it("links a GitHub issue to its page from the key alone", () => {
    expect(issueReference("github", "acme/app#7")).toEqual({
      key: "acme/app#7",
      url: "https://github.com/acme/app/issues/7",
      trackerName: "GitHub",
    });
  });

  it("links a Jira issue through the tracker, dropping a url that throws or is not https", () => {
    expect(issueReference("jira", "PROJ-13", jiraUrl)).toEqual({
      key: "PROJ-13",
      url: "https://example.atlassian.net/browse/PROJ-13",
      trackerName: "Jira",
    });
    expect(issueReference("jira", "PROJ-13")).toEqual({ key: "PROJ-13", trackerName: "Jira" });
    expect(issueReference("jira", "PROJ-13", () => "http://x/PROJ-13")).toEqual({
      key: "PROJ-13",
      trackerName: "Jira",
    });
    const throws = () => {
      throw new Error("no site");
    };
    expect(issueReference("jira", "PROJ-13", throws)).toEqual({ key: "PROJ-13", trackerName: "Jira" });
  });

  it("refuses a key malformed for its provider, and an unknown provider", () => {
    for (const [provider, key] of [
      ["github", "Acme/App#7"],
      ["github", "acme/app#0"],
      ["github", "acme#7"],
      ["github", "acme/app#7)](https://evil"],
      ["github", "PROJ-13"],
      ["jira", "acme/app#7"],
      ["jira", "proj-13"],
      ["linear", "PROJ-13"],
    ]) {
      expect(issueReference(provider, key, jiraUrl)).toBeUndefined();
    }
  });
});
