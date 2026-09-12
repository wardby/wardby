import { describe, it, expect } from "vitest";
import { preflight } from "./preflight.js";
import type { Bundle } from "./bundle.js";

function fakeBundle(over: Partial<Record<string, unknown[]>> = {}): Bundle {
  return {
    manifest: { capabilities: ["subagents", "memory", "budgets"] } as any,
    readAgents: () =>
      (over.agents as any) ?? [
        {
          name: "ok",
          model: "gpt-4o",
          systemPrompt: "s",
          scheduleEnabled: true,
          maxTurns: 5,
          budgetUsd: "5",
          schedule: null,
          timezone: "UTC",
          provider: "openai",
          kind: "native",
          memoryEnabled: false,
          unmodeled: {},
        },
        {
          name: "claude",
          model: "us.anthropic.x",
          systemPrompt: "s",
          scheduleEnabled: true,
          maxTurns: 5,
          budgetUsd: "5",
          schedule: null,
          timezone: "UTC",
          provider: "bedrock",
          kind: "native",
          memoryEnabled: false,
          unmodeled: {},
        },
      ],
    readTools: () =>
      (over.tools as any) ?? [
        {
          name: "good",
          paramsZod: "z.object({})",
          code: "await fetch('x')",
          description: "",
          jsonSchema: null,
          secretSchema: "",
        },
        // sendEmail is a throwing placeholder now (Task 5 Part A) — it imports fine.
        // npmLockUpdate is roadmap-excluded and absent from the sandbox, so it is
        // the one host API a tool may reference that gets rejected at import.
        {
          name: "emailer",
          paramsZod: "z.object({})",
          code: "await sendEmail({})",
          description: "",
          jsonSchema: null,
          secretSchema: "",
        },
        {
          name: "locker",
          paramsZod: "z.object({})",
          code: "await npmLockUpdate({})",
          description: "",
          jsonSchema: null,
          secretSchema: "",
        },
      ],
    readAgentTools: () => (over.agentTools as any) ?? [],
    readSecrets: () => [],
    readAgentSecrets: () => [],
    readSingleDatastores: () => [],
    readSharedDatastores: () => [],
    readWebhooks: () => [],
    readBudgets: () => (over.budgets as any) ?? [],
  };
}

const baseInput = {
  routableModels: new Set(["gpt-4o"]),
  // Mirrors the real prelude after Task 5 Part A: the email placeholders are
  // supported globals; npmLockUpdate is deliberately absent.
  supportedGlobals: new Set(["fetch", "datastore", "sendEmail", "getInboundEmail"]),
  existingAgentNames: new Set<string>(),
  existingToolNames: new Set<string>(),
  capabilitiesSupported: new Set(["budgets"]),
  onConflict: "fail" as const,
  prefix: "imported-",
  allowOpenFetch: false,
};

describe("preflight", () => {
  it("disables an agent with an unroutable model but keeps it", () => {
    const r = preflight({ bundle: fakeBundle(), ...baseInput });
    const claude = r.agents.find((a) => a.name === "claude")!;
    expect(claude.disabled).toBe(true);
    expect(claude.disabledReason).toMatch(/not routable/);
    expect(r.agents.find((a) => a.name === "ok")!.disabled).toBe(false);
  });

  it("imports a sendEmail tool (throwing placeholder) but rejects a npmLockUpdate tool", () => {
    const r = preflight({ bundle: fakeBundle(), ...baseInput });
    expect(r.tools.find((t) => t.name === "emailer")!.rejected).toBeUndefined();
    expect(r.tools.find((t) => t.name === "locker")!.rejected).toMatch(/npmLockUpdate/);
    expect(r.tools.find((t) => t.name === "good")!.rejected).toBeUndefined();
  });

  it("lists unsupported capabilities as skipped", () => {
    const r = preflight({ bundle: fakeBundle(), ...baseInput });
    expect(r.skippedCapabilities.sort()).toEqual(["memory", "subagents"]);
  });

  it("flags a fatal agent-name collision under --on-conflict fail", () => {
    const r = preflight({ bundle: fakeBundle(), ...baseInput, existingAgentNames: new Set(["ok"]) });
    expect(r.hasFatalCollision).toBe(true);
    expect(r.collisions.some((c) => c.kind === "agent" && c.name === "ok" && c.action === "fail")).toBe(true);
  });

  it("renames a colliding tool under --on-conflict rename and records the remap", () => {
    const r = preflight({
      bundle: fakeBundle(),
      ...baseInput,
      onConflict: "rename",
      existingToolNames: new Set(["good"]),
    });
    expect(r.nameRemap.get("good")).toBe("imported-good");
    expect(r.hasFatalCollision).toBe(false);
  });

  it("treats an occupied rename target as a fatal collision instead of adopting it", () => {
    const r = preflight({
      bundle: fakeBundle(),
      ...baseInput,
      onConflict: "rename",
      existingToolNames: new Set(["good", "imported-good"]),
    });
    expect(r.nameRemap.has("good")).toBe(false);
    expect(r.hasFatalCollision).toBe(true);
    expect(r.collisions.some((c) => c.kind === "tool" && c.name === "good" && c.action === "fail")).toBe(true);
    expect(r.notes.some((n) => n.includes("imported-good") && n.includes("already exists"))).toBe(true);
  });

  it("marks a disabled budget as skipped", () => {
    const r = preflight({
      bundle: fakeBundle({
        budgets: [
          {
            name: "cap",
            period: "monthly",
            alertThreshold: "80",
            blockThreshold: "100",
            enabled: false,
            alertEmails: [],
            attachedAgentNames: [],
            ownerEmail: null,
          },
        ],
      }),
      ...baseInput,
    });
    expect(r.budgets.find((b) => b.name === "cap")!.skippedReason).toBe("disabled");
  });
});
