import type { Bundle } from "./bundle.js";
import { classifyModel } from "./model-gate.js";
import { scanToolCode } from "./tool-scan.js";
import { mapBudget } from "./budgets.js";

export type ConflictPolicy = "fail" | "skip" | "rename";

export interface PreflightInput {
  bundle: Bundle;
  routableModels: ReadonlySet<string>;
  supportedGlobals: ReadonlySet<string>;
  existingAgentNames: ReadonlySet<string>;
  existingToolNames: ReadonlySet<string>;
  capabilitiesSupported: ReadonlySet<string>;
  onConflict: ConflictPolicy;
  prefix: string;
  allowOpenFetch: boolean;
}

export interface Reconciliation {
  nameRemap: Map<string, string>;
  agents: { name: string; disabled: boolean; disabledReason?: string; skipped?: string }[];
  tools: { name: string; rejected?: string; skipped?: string }[];
  skippedCapabilities: string[];
  budgets: { name: string; skippedReason?: string }[];
  collisions: { kind: "agent" | "tool"; name: string; action: ConflictPolicy; newName?: string }[];
  notes: string[];
  hasFatalCollision: boolean;
}

export function preflight(input: PreflightInput): Reconciliation {
  const { bundle, onConflict, prefix } = input;
  const nameRemap = new Map<string, string>();
  const collisions: Reconciliation["collisions"] = [];
  const notes: string[] = [];
  let hasFatalCollision = false;

  const resolveCollision = (kind: "agent" | "tool", name: string, existing: ReadonlySet<string>) => {
    if (!existing.has(name)) return { skipped: undefined as string | undefined };
    if (onConflict === "fail") {
      hasFatalCollision = true;
      collisions.push({ kind, name, action: "fail" });
      return { skipped: "collision" };
    }
    if (onConflict === "skip") {
      collisions.push({ kind, name, action: "skip" });
      return { skipped: "collision" };
    }
    const newName = prefix + name;
    // Rename target must itself be free; otherwise the upsert would adopt an
    // unrelated pre-existing row. Treat an occupied target as a fatal collision.
    if (existing.has(newName)) {
      hasFatalCollision = true;
      collisions.push({ kind, name, action: "fail" });
      notes.push(`${kind} ${name}: rename target "${newName}" already exists — cannot resolve collision`);
      return { skipped: "collision" };
    }
    nameRemap.set(name, newName);
    collisions.push({ kind, name, action: "rename", newName });
    return { skipped: undefined };
  };

  const agents = bundle.readAgents().map((a) => {
    const c = resolveCollision("agent", a.name, input.existingAgentNames);
    if (c.skipped === "collision") return { name: a.name, disabled: false, skipped: "collision" };
    const routable = classifyModel(a.model, input.routableModels) === "routable";
    // Controller Ruling B: disabled flag reflects MODEL ROUTABILITY ONLY
    return routable
      ? { name: a.name, disabled: false }
      : {
          name: a.name,
          disabled: true,
          disabledReason: `model ${a.model} not routable — no registered provider serves it`,
        };
  });

  const tools = bundle.readTools().map((t) => {
    const c = resolveCollision("tool", t.name, input.existingToolNames);
    if (c.skipped === "collision") return { name: t.name, skipped: "collision" };
    const scan = scanToolCode(t.code, input.supportedGlobals);
    return scan.ok
      ? { name: t.name }
      : { name: t.name, rejected: `uses unsupported host API: ${scan.rejectedApis.join(", ")}` };
  });

  const skippedCapabilities = bundle.manifest.capabilities.filter((c) => !input.capabilitiesSupported.has(c));

  const budgets = bundle.readBudgets().map((b) => {
    const m = mapBudget(b);
    return m.ok ? { name: b.name } : { name: b.name, skippedReason: m.reason };
  });

  if (!input.allowOpenFetch) {
    for (const at of bundle.readAgentTools()) {
      if (at.allowedHosts.includes("*")) {
        notes.push(`agent-tool ${at.agentName}/${at.toolName}: "*" host dropped (no --allow-open-fetch)`);
      }
    }
  }

  return { nameRemap, agents, tools, skippedCapabilities, budgets, collisions, notes, hasFatalCollision };
}
