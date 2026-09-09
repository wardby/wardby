import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openBundle, BundleError } from "./bundle.js";

let dir: string;
const manifest = {
  bundleVersion: 1,
  source: { product: "agent-cron", exporterVersion: "1.0.0", exportedAt: "2026-09-08T00:00:00.000Z" },
  secretMode: "references", transferKeyId: null,
  capabilities: ["budgets"], counts: { agents: 1 },
};
function write(rel: string, obj: unknown) {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(obj));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bundle-"));
  write("manifest.json", manifest);
  write("config/agents.json", [{
    name: "digest", systemPrompt: "sp", provider: "bedrock", model: "m",
    schedule: "", scheduleEnabled: true, maxTurns: 8, budgetUsd: "5.00",
  }]);
  write("config/budgets.json", []); // wrong place on purpose; real place is capabilities/
  write("capabilities/budgets.json", [{
    name: "cap", period: "monthly", alertThreshold: "80.00", blockThreshold: "100.00", enabled: true,
    attachedAgentNames: ["digest"],
  }]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("openBundle", () => {
  it("opens a valid directory and reads agents", () => {
    const b = openBundle(dir);
    expect(b.manifest.bundleVersion).toBe(1);
    expect(b.readAgents()).toHaveLength(1);
    expect(b.readAgents()[0].schedule).toBe("");
  });

  it("reads budgets from capabilities/", () => {
    expect(openBundle(dir).readBudgets()).toHaveLength(1);
  });

  it("returns [] for absent optional files", () => {
    expect(openBundle(dir).readWebhooks()).toEqual([]);
  });

  it("throws BundleError when the path is a file, not a dir", () => {
    expect(() => openBundle(join(dir, "manifest.json"))).toThrow(BundleError);
  });

  it("throws BundleError on a bad bundleVersion", () => {
    write("manifest.json", { ...manifest, bundleVersion: 2 });
    expect(() => openBundle(dir)).toThrow(/bundleVersion/);
  });

  it("throws BundleError naming the file on invalid content", () => {
    write("config/agents.json", [{ name: "x" }]); // missing required fields
    expect(() => openBundle(dir).readAgents()).toThrow(/config\/agents\.json/);
  });
});
