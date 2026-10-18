import { describe, expect, it } from "vitest";
import { CONTINUATION_CLOSED_CATEGORY, CONTINUATION_CLOSED_SENTENCE } from "../coding/continuation-wording.js";
import { PROTECTED_PATH_CATEGORY } from "../coding/protected-path-wording.js";
import { SERVICE_UNREADY_CATEGORY } from "../coding/services/wording.js";
import type { ProviderFailureClass } from "./provider-wording.js";
import { ownerBudgetSentence } from "./budget-events.js";
import { codingChildResult } from "./runner.js";

const base = { finalText: null, costUsd: "0.25", tokensIn: 10, tokensOut: 5 };

describe("codingChildResult", () => {
  it("reports a finished coding sub-run's status, reply, and usage", () => {
    expect(
      JSON.parse(codingChildResult({ ...base, status: "succeeded", finalText: "Opened a PR.", error: null })),
    ).toEqual({
      status: "succeeded",
      finalText: "Opened a PR.",
      costUsd: 0.25,
      tokensIn: 10,
      tokensOut: 5,
    });
  });

  it("cites the pull request from wardby's stored result, not the sub-agent's text", () => {
    const result = JSON.parse(
      codingChildResult(
        { ...base, status: "succeeded", finalText: "Done.", error: null },
        {
          outcome: "pull_request_opened",
          repository: "acme/api",
          pullRequestNumber: 7,
          pullRequestUrl: "https://github.com/acme/api/pull/7",
        },
      ),
    );
    expect(result.pullRequest).toEqual({
      outcome: "opened",
      repository: "acme/api",
      number: 7,
      url: "https://github.com/acme/api/pull/7",
    });
    expect(
      JSON.parse(
        codingChildResult(
          { ...base, status: "succeeded", finalText: null, error: null },
          { outcome: "pull_request_updated", repository: "acme/api", pullRequestNumber: 7 },
        ),
      ).pullRequest,
    ).toEqual({ outcome: "updated", repository: "acme/api", number: 7 });
  });

  it("tells the parent why a sub-run failed by its error code only, never the raw message", () => {
    const failed = JSON.parse(
      codingChildResult({
        ...base,
        status: "failed",
        error: "coding_worker_image_invalid: registry.internal:5000/img is not pinned by digest",
      }),
    );
    expect(failed.errorCode).toBe("coding_worker_image_invalid");
    expect(JSON.stringify(failed)).not.toContain("registry.internal");
    // An error without a leading code adds nothing; only a failed run carries one.
    expect(
      JSON.parse(codingChildResult({ ...base, status: "failed", error: "Something broke at 10.0.0.1" })),
    ).not.toHaveProperty("errorCode");
    expect(
      JSON.parse(codingChildResult({ ...base, status: "cancelled", error: "stopped_by_user: no longer needed" })),
    ).not.toHaveProperty("errorCode");
  });

  it("adds no pull request when the sub-run opened none or its result is malformed", () => {
    for (const stored of [
      undefined,
      null,
      { outcome: "no_changes" },
      { outcome: "pull_request_opened", pullRequestNumber: -1 },
    ]) {
      expect(
        JSON.parse(codingChildResult({ ...base, status: "succeeded", finalText: null, error: null }, stored)),
      ).not.toHaveProperty("pullRequest");
    }
  });

  it("gives the router the host sentence of a service refusal, never the raw error", () => {
    const result = JSON.parse(
      codingChildResult({
        ...base,
        status: "refused",
        error: "service_unknown: This repository asks for `postgres 18`, which wardby's service catalog doesn't have.",
      }),
    );
    expect(result).toMatchObject({
      status: "refused",
      refusal: "This repository asks for `postgres 18`, which wardby's service catalog doesn't have.",
    });
    expect(JSON.stringify(result)).not.toContain("service_unknown");
  });

  it("adds nothing for any other refusal", () => {
    const result = JSON.parse(codingChildResult({ ...base, status: "refused", error: "run_tree_exhausted: spent" }));
    expect(result).not.toHaveProperty("refusal");
  });

  it("tells the parent a continuation found its PR no longer open, never the raw error", () => {
    const out = JSON.parse(
      codingChildResult({
        status: "failed",
        finalText: null,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        error: "coding_failure_continuation_closed:coding_diag_1",
      }),
    );
    expect(out.refusal).toBe(CONTINUATION_CLOSED_SENTENCE);
    expect(JSON.stringify(out)).not.toContain("coding_diag_1");
  });

  it('gives the same sentence when the PR closed before any spend, even though that sub-run is "refused"', () => {
    const out = JSON.parse(
      codingChildResult({
        status: "refused",
        finalText: null,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        error: "coding_failure_continuation_closed:coding_diag_2",
      }),
    );
    expect(out).toMatchObject({ status: "refused", refusal: CONTINUATION_CLOSED_SENTENCE });
    expect(JSON.stringify(out)).not.toContain("coding_diag_2");
  });

  it("tells the lead why a budget-exhausted or refused child stopped, from the recorded event", () => {
    const proxyEvent = {
      kind: "refused" as const,
      limit: "run" as const,
      at: new Date(0).toISOString(),
      details: {
        source: "proxy" as const,
        budgetUsd: 3,
        spentUsd: 2.9,
        heldReservedUsd: 0,
        heldUncertainUsd: 0,
        refusedHoldUsd: 0.4,
        model: "m",
        turn: 7,
      },
    };
    const dispatchEvent = {
      kind: "refused" as const,
      limit: "run-tree" as const,
      at: new Date(0).toISOString(),
      details: { source: "dispatch" as const, capUsd: 5, spentUsd: 5, heldUsd: 0, heldRuns: 0, leadAgentName: "lead" },
    };
    const exhausted = JSON.parse(
      codingChildResult({ ...base, status: "budget_exhausted", error: null }, undefined, {
        event: proxyEvent,
        agentName: "builder",
      }),
    );
    expect(exhausted.budget).toBe(ownerBudgetSentence(proxyEvent, "builder"));
    const refused = JSON.parse(
      codingChildResult({ ...base, status: "refused", error: "run_tree_exhausted: spent" }, undefined, {
        event: dispatchEvent,
        agentName: "builder",
      }),
    );
    expect(refused.budget).toBe(ownerBudgetSentence(dispatchEvent, "builder"));
    expect(refused.budget).toContain("Could not start");
    const none = JSON.parse(codingChildResult({ ...base, status: "budget_exhausted", error: null }));
    expect(none).not.toHaveProperty("budget");
  });
});

describe("codingChildResult error codes", () => {
  it("omits a leading code that is not declared", () => {
    const stored = { ...base, status: "failed", error: "fake_unlisted_code_0001: detail" };
    const out = codingChildResult(stored);
    expect(out.includes("fake_unlisted_code_0001")).toBe(false);
  });

  it("passes wardby's own failure codes through", () => {
    for (const code of [
      "coding_queue_timeout",
      "coding_workspace_lost",
      "coding_toolchain_unsupported",
      "native_sandbox_worker_lost",
      "model_unavailable",
    ]) {
      const out = JSON.parse(codingChildResult({ ...base, status: "failed", error: `${code}: detail` }));
      expect(out.errorCode === code).toBe(true);
    }
  });
  it("passes the container executor's terminal coding_failure_<category> codes through", () => {
    const categories = [
      "turn_limit",
      SERVICE_UNREADY_CATEGORY,
      "preflight",
      "job",
      "repo_access_unavailable",
      "repo_access",
      "github",
      PROTECTED_PATH_CATEGORY,
      CONTINUATION_CLOSED_CATEGORY,
      "workspace",
      "budget",
      "artifact",
      "cancelled",
      "executor",
    ];
    for (const category of categories) {
      const code = `coding_failure_${category}`;
      const out = JSON.parse(codingChildResult({ ...base, status: "failed", error: `${code}:coding_diag_x` }));
      expect({ category, passed: out.errorCode === code }).toEqual({ category, passed: true });
    }
  });

  it("passes coding_provider_<class> through for every provider failure class", () => {
    const classes: Record<ProviderFailureClass, true> = {
      quota: true,
      rate_limited: true,
      unavailable: true,
      rejected: true,
    };
    for (const providerClass of Object.keys(classes)) {
      const code = `coding_provider_${providerClass}`;
      const out = JSON.parse(codingChildResult({ ...base, status: "failed", error: code }));
      expect({ providerClass, passed: out.errorCode === code }).toEqual({ providerClass, passed: true });
    }
  });

  it("omits an unlisted coding_failure_ word", () => {
    const out = JSON.parse(
      codingChildResult({ ...base, status: "failed", error: "coding_failure_fakeword:coding_diag_x" }),
    );
    expect(out).not.toHaveProperty("errorCode");
  });
});
