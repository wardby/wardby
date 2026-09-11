import { describe, it, expect } from "vitest";
import {
  ManifestSchema, NeutralAgentSchema, NeutralToolSchema,
  NeutralAgentToolSchema, NeutralSecretSchema, NeutralBudgetSchema,
} from "./neutral-schema.js";

describe("neutral-schema", () => {
  it("parses a minimal manifest and defaults optional windows to null", () => {
    const m = ManifestSchema.parse({
      bundleVersion: 1,
      source: { product: "agent-cron", exporterVersion: "1.0.0", exportedAt: "2026-09-08T00:00:00.000Z" },
      secretMode: "envelope", transferKeyId: "bcf0544926dd0b1c",
      capabilities: ["subagents", "memory", "shared-datastores", "budgets"],
      counts: {},
    });
    expect(m.contentWindowDays).toBeNull();
    expect(m.toolCallDetail).toBe("metadata");
  });

  it("accepts a references-mode manifest with null transferKeyId", () => {
    const m = ManifestSchema.parse({
      bundleVersion: 1,
      source: { product: "agent-cron", exporterVersion: "1.0.0", exportedAt: "2026-09-08T00:00:00.000Z" },
      secretMode: "references", transferKeyId: null, capabilities: [], counts: {},
    });
    expect(m.secretMode).toBe("references");
  });

  it("parses an agent with the unmodeled sub-object", () => {
    const a = NeutralAgentSchema.parse({
      name: "digest", systemPrompt: "sp", provider: "bedrock",
      model: "us.anthropic.claude-opus-4-6-v1", region: "us-east-1",
      schedule: "", timezone: "UTC", scheduleEnabled: true, maxTurns: 8,
      budgetUsd: "5.00", ownerEmail: null, kind: "native", memoryEnabled: true,
      unmodeled: { description: "d", slug: "digest", emailAllowlist: null },
    });
    expect(a.schedule).toBe("");        // "" = manual-only, preserved
    expect(a.region).toBe("us-east-1");
  });

  it("parses an envelope secret shell", () => {
    const s = NeutralSecretSchema.parse({
      name: "API_KEY", description: null, ownerEmail: null,
      ciphertext: { v: 1, alg: "x25519-hkdf-sha256-chacha20poly1305-v1",
        epk: "aa", nonce: "bb", ct: "cc", tag: "dd" },
    });
    expect(s.ciphertext?.alg).toContain("x25519");
  });

  it("parses an agent-tool edge with synthesized capabilities", () => {
    const at = NeutralAgentToolSchema.parse({
      agentName: "a", toolName: "fetch-jira", allowedSecrets: ["jira_token"],
      allowedDatastorePrefixes: [], allowedHosts: ["x.atlassian.net"], hostsSource: "firewall-approved",
    });
    expect(at.allowedHosts).toEqual(["x.atlassian.net"]);
  });

  it("parses a budget with string thresholds", () => {
    const b = NeutralBudgetSchema.parse({
      name: "cap", ownerEmail: null, period: "monthly",
      alertThreshold: "80.00", blockThreshold: "100.00", alertEmails: [], enabled: true,
      attachedAgentNames: ["a", "b"],
    });
    expect(b.period).toBe("monthly");
  });

  it("rejects an unknown secretMode", () => {
    expect(() => ManifestSchema.parse({
      bundleVersion: 1,
      source: { product: "agent-cron", exporterVersion: "1.0.0", exportedAt: "x" },
      secretMode: "plaintext", transferKeyId: null, capabilities: [], counts: {},
    })).toThrow();
  });
});
