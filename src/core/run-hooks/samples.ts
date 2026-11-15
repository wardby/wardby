/**
 * One representative stored payload per hook event kind. create_run_hook and
 * update_run_hook validate a hook's config by running the tool's paramsZod
 * against `{ event: <sample of each subscribed kind>, config }`, and
 * test_run_hook delivers the run_completed sample. Placeholder values only.
 */
import type { HookEventKind, RecordedPayload } from "../workflow-events.js";

const PR = { prLabel: "your-org/your-repo#1", prUrl: "https://github.com/your-org/your-repo/pull/1" };

export const SAMPLE_PAYLOADS: Record<HookEventKind, RecordedPayload> = {
  issue_picked_up: { kind: "issue_picked_up", agentName: "example-agent", trigger: "issue_mention" },
  run_failed: { kind: "run_failed", agentName: "example-agent", status: "failed", reason: "example failure" },
  run_blocked: { kind: "run_blocked", agentName: "example-agent", packageRefusals: [] },
  pr_opened: { kind: "pr_opened", ...PR, movedTo: null },
  review_posted: {
    kind: "review_posted",
    agentName: "example-agent",
    verdict: "COMMENT",
    ...PR,
    ciPending: false,
  },
  review_fix: { kind: "review_fix", prLabel: PR.prLabel, round: 1, maxRounds: 2, state: "started" },
  pr_closed: { kind: "pr_closed", ...PR, merged: true, movedTo: null },
  packages_audited: {
    kind: "packages_audited",
    agentName: "example-agent",
    mode: "audit",
    toApprove: [],
    moreToApprove: 0,
    unknown: [],
    moreUnknown: 0,
    transitive: 0,
    advisories: 0,
  },
  run_completed: {
    kind: "run_completed",
    agentName: "example-agent",
    status: "succeeded",
    trigger: "scheduled",
    parentRunId: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    finishedAt: "2026-01-01T00:05:00.000Z",
    costUsd: "0.000000",
    reason: null,
    pullRequests: [
      {
        repository: "your-org/app",
        number: 12,
        url: "https://github.com/your-org/app/pull/12",
        outcome: "pull_request_opened",
      },
      {
        repository: "your-org/tools",
        number: 7,
        url: "https://github.com/your-org/tools/pull/7",
        outcome: "pull_request_opened",
      },
    ],
  },
};

export const TEST_FINAL_TEXT = "(test_run_hook: placeholder final text)";
