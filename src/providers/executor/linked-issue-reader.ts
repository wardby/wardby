import type { IssueTrackerRegistry } from "../issue-tracker/types.js";
import type { ReviewHostRegistry } from "../review-host/types.js";
import type { LinkedIssueRef } from "./container.js";

/** A tracker read for a continuation's task must not hold up its launch. */
const TRACKER_READ_TIMEOUT_MS = 10_000;

/**
 * The executor's readLinkedIssue: a GitHub issue through the review host's
 * issue read (the App's installation token for the run's repository), a Jira
 * issue through the configured tracker. Null when the number is a pull
 * request, the issue is missing, or no host or tracker is configured.
 */
export function linkedIssueReader(deps: {
  hosts: ReviewHostRegistry;
  issueTrackers: IssueTrackerRegistry;
}): (ref: LinkedIssueRef) => Promise<{ title: string; body: string } | null> {
  return async (ref) => {
    if (ref.provider === "github") {
      const host = deps.hosts.github;
      if (!host?.readIssue) return null;
      // Title and body only: the task carries the ticket, not its discussion.
      const result = await host.readIssue(ref.repository, ref.number, { comments: false });
      return result.kind === "issue" ? { title: result.title, body: result.body } : null;
    }
    const tracker = deps.issueTrackers.jira;
    if (!tracker) return null;
    const view = await tracker.getIssue(ref.key, {
      maxComments: 0,
      agentMarker: "",
      timeoutMs: TRACKER_READ_TIMEOUT_MS,
      retryOn429: false,
    });
    return { title: view.summary, body: view.description };
  };
}
