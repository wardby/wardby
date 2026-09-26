import { describe, expect, it, vi } from "vitest";
import type { CodeReviewHost } from "../providers/review-host/types.js";
import { closeOpenHostCheck } from "./review-host-checks.js";

function db(row: Record<string, unknown> | null) {
  return {
    runHostCheck: {
      findUnique: vi.fn(async () => row),
      update: vi.fn(async () => row),
    },
  } as never;
}

const host = () => ({ provider: "github", completeCheck: vi.fn(async () => undefined) }) as unknown as CodeReviewHost;

describe("closeOpenHostCheck", () => {
  it("completes an open check as neutral and records it", async () => {
    const h = host();
    const d = db({
      runId: "r1",
      provider: "github",
      repository: "o/n",
      checkId: "11",
      headSha: "a",
      completedAt: null,
    });
    await closeOpenHostCheck(d, { id: "r1", status: "failed" }, { github: h });
    expect(h.completeCheck).toHaveBeenCalledWith("o/n", {
      checkId: "11",
      conclusion: "neutral",
      title: "Review did not complete",
      summary: 'wardby run r1 ended with status "failed" before publishing a review. Use Re-run to try again.',
    });
    expect((d as { runHostCheck: { update: ReturnType<typeof vi.fn> } }).runHostCheck.update).toHaveBeenCalledOnce();
  });

  it("does nothing for a completed check, no check, or no hosts, and never throws", async () => {
    const h = host();
    await closeOpenHostCheck(
      db({ runId: "r1", provider: "github", repository: "o/n", checkId: "11", completedAt: new Date() }),
      { id: "r1", status: "succeeded" },
      { github: h },
    );
    await closeOpenHostCheck(db(null), { id: "r1", status: "succeeded" }, { github: h });
    await closeOpenHostCheck(db(null), { id: "r1", status: "succeeded" }, undefined);
    expect(h.completeCheck).not.toHaveBeenCalled();

    vi.mocked(h.completeCheck).mockRejectedValueOnce(new Error("github_api_unavailable"));
    await expect(
      closeOpenHostCheck(
        db({ runId: "r1", provider: "github", repository: "o/n", checkId: "11", completedAt: null }),
        { id: "r1", status: "failed" },
        { github: h },
      ),
    ).resolves.toBeUndefined();
  });
});
