import type { Reconciliation } from "./preflight.js";

export function renderReconciliation(
  r: Reconciliation,
  opts: { secretMode: "references" | "envelope"; dryRun: boolean },
): string {
  const lines: string[] = [];

  // Dry run banner
  if (opts.dryRun) {
    lines.push("DRY RUN — no changes written");
    lines.push("");
  }

  // Secret mode notice
  lines.push(`Secret mode: ${opts.secretMode}`);
  lines.push("");

  // Agents
  lines.push("Agents:");
  const disabledAgents = r.agents.filter((a) => a.disabled || a.skipped);
  if (disabledAgents.length > 0) {
    for (const a of disabledAgents) {
      if (a.disabled && a.disabledReason) {
        lines.push(`  - ${a.name} (disabled): ${a.disabledReason}`);
      } else if (a.skipped) {
        lines.push(`  - ${a.name}: skipped (${a.skipped})`);
      }
    }
  } else {
    lines.push("  (all agents importable)");
  }
  lines.push("");

  // Tools
  lines.push("Tools:");
  const rejectedTools = r.tools.filter((t) => t.rejected || t.skipped);
  if (rejectedTools.length > 0) {
    for (const t of rejectedTools) {
      if (t.rejected) {
        lines.push(`  - ${t.name} (rejected): ${t.rejected}`);
      } else if (t.skipped) {
        lines.push(`  - ${t.name}: skipped (${t.skipped})`);
      }
    }
  } else {
    lines.push("  (all tools importable)");
  }
  lines.push("");

  // Skipped capabilities
  lines.push("Skipped capabilities:");
  if (r.skippedCapabilities.length > 0) {
    for (const cap of r.skippedCapabilities) {
      lines.push(`  - ${cap}`);
    }
  } else {
    lines.push("  (none)");
  }
  lines.push("");

  // Budgets
  lines.push("Budgets:");
  const skippedBudgets = r.budgets.filter((b) => b.skippedReason);
  if (skippedBudgets.length > 0) {
    for (const b of skippedBudgets) {
      lines.push(`  - ${b.name}: skipped (${b.skippedReason})`);
    }
  } else {
    lines.push("  (all budgets importable)");
  }
  lines.push("");

  // Collisions
  lines.push("Collisions:");
  if (r.collisions.length > 0) {
    for (const c of r.collisions) {
      if (c.action === "rename") {
        lines.push(`  - ${c.kind} ${c.name} → ${c.newName} (renamed)`);
      } else {
        lines.push(`  - ${c.kind} ${c.name} (${c.action})`);
      }
    }
  } else {
    lines.push("  (none)");
  }
  lines.push("");

  // Notes
  lines.push("Notes:");
  if (r.notes.length > 0) {
    for (const note of r.notes) {
      lines.push(`  - ${note}`);
    }
  } else {
    lines.push("  (none)");
  }
  lines.push("");

  // Webhook secret notice (always shown)
  lines.push("Webhook secrets will be regenerated and shown once at creation.");

  return lines.join("\n");
}
