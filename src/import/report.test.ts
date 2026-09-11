import { describe, it, expect } from "vitest";
import { renderReconciliation } from "./report.js";
import type { Reconciliation } from "./preflight.js";

const r: Reconciliation = {
  nameRemap: new Map(),
  agents: [{ name: "ok", disabled: false }, { name: "claude", disabled: true, disabledReason: "model X not routable — no registered provider serves it" }],
  tools: [{ name: "good" }, { name: "locker", rejected: "uses unsupported host API: npmLockUpdate" }],
  skippedCapabilities: ["subagents", "memory"],
  budgets: [{ name: "cap", skippedReason: "disabled" }],
  collisions: [], notes: [], hasFatalCollision: false,
};

describe("renderReconciliation", () => {
  it("lists disabled agents, rejected tools, skipped capabilities and budgets", () => {
    const out = renderReconciliation(r, { secretMode: "references", dryRun: true });
    expect(out).toMatch(/claude.*not routable/);
    expect(out).toMatch(/locker.*npmLockUpdate/);
    expect(out).toMatch(/subagents/);
    expect(out).toMatch(/cap.*disabled/);
    expect(out).toMatch(/references/i);
    expect(out).toMatch(/dry.run/i);
  });

  it("notes webhook secret regeneration", () => {
    expect(renderReconciliation(r, { secretMode: "envelope", dryRun: false })).toMatch(/webhook secret/i);
  });
});
