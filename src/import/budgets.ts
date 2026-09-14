import type { NeutralBudget } from "./neutral-schema.js";

export interface BudgetGroupData {
  name: string;
  dailyBudgetUsd: string | null;
  weeklyBudgetUsd: string | null;
  monthlyBudgetUsd: string | null;
  warnThresholdRatio: string;
}

function warnRatio(alert: string, block: string): string {
  const a = Number(alert),
    b = Number(block);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return "0.8";
  const r = a / b;
  if (!Number.isFinite(r) || r <= 0) return "0.8";
  return Math.min(r, 1).toFixed(2);
}

export function mapBudget(
  b: NeutralBudget,
): { ok: true; group: BudgetGroupData; agentNames: string[] } | { ok: false; reason: string } {
  if (!b.enabled) return { ok: false, reason: "disabled" };
  const group: BudgetGroupData = {
    name: b.name,
    dailyBudgetUsd: b.period === "daily" ? b.blockThreshold : null,
    weeklyBudgetUsd: b.period === "weekly" ? b.blockThreshold : null,
    monthlyBudgetUsd: b.period === "monthly" ? b.blockThreshold : null,
    warnThresholdRatio: warnRatio(b.alertThreshold, b.blockThreshold),
  };
  return { ok: true, group, agentNames: b.attachedAgentNames };
}
