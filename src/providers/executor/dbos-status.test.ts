import { describe, expect, it } from "vitest";
import { decideRecovery } from "./dbos-status.js";

describe("decideRecovery", () => {
  it("treats a PENDING workflow owned by this executor as active", () => {
    expect(decideRecovery({ status: "PENDING", executorId: "me" }, false, "me")).toEqual({ action: "active" });
  });

  it("adopts a PENDING workflow owned by another executor by resuming it here", () => {
    expect(decideRecovery({ status: "PENDING", executorId: "dead-node" }, false, "me")).toEqual({ action: "resume" });
  });

  it("adopts an ENQUEUED or DELAYED workflow the same way", () => {
    expect(decideRecovery({ status: "ENQUEUED" }, false, "me")).toEqual({ action: "resume" });
    expect(decideRecovery({ status: "DELAYED" }, false, "me")).toEqual({ action: "resume" });
  });

  it("reports terminal when the workflow succeeded and the run row is already terminal", () => {
    expect(decideRecovery({ status: "SUCCESS" }, true, "me")).toEqual({ action: "terminal" });
  });

  it("marks the run failed when the workflow ended but the run row never reached a terminal state", () => {
    expect(decideRecovery({ status: "SUCCESS" }, false, "me")).toEqual({
      action: "mark-failed",
      error: "Durable workflow finished (SUCCESS) without persisting a terminal run state.",
    });
    expect(decideRecovery({ status: "ERROR" }, false, "me")).toEqual({
      action: "mark-failed",
      error: "Durable workflow finished (ERROR) without persisting a terminal run state.",
    });
    expect(decideRecovery({ status: "CANCELLED" }, false, "me")).toEqual({
      action: "mark-failed",
      error: "Durable workflow finished (CANCELLED) without persisting a terminal run state.",
    });
    expect(decideRecovery({ status: "MAX_RECOVERY_ATTEMPTS_EXCEEDED" }, false, "me")).toEqual({
      action: "mark-failed",
      error: "Durable workflow finished (MAX_RECOVERY_ATTEMPTS_EXCEEDED) without persisting a terminal run state.",
    });
  });

  it("reports lost when DBOS has no record of the workflow", () => {
    expect(decideRecovery(null, false, "me")).toEqual({
      action: "lost",
      reason: "Durable workflow record not found; the run was never started or its record was purged.",
    });
  });

  it("reports lost for an unknown status string rather than guessing", () => {
    expect(decideRecovery({ status: "SOMETHING_NEW" }, false, "me")).toEqual({
      action: "lost",
      reason: 'Durable workflow is in unrecognised status "SOMETHING_NEW".',
    });
  });
});
