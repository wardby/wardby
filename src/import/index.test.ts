import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock dependencies for hermetic tests
vi.mock("./create.js", () => ({
  createFromBundle: vi.fn(async () => ({
    agentsCreated: 0,
    toolsCreated: 0,
    secretsCreated: 0,
    datastoreEntries: 0,
    budgetGroupsCreated: 0,
    webhookSecrets: [],
    pendingSecretReentry: [],
    warnings: [],
  })),
}));

vi.mock("../config/providers.js", () => ({
  loadProviderConfig: vi.fn(() => ({ secrets: "app-key" })),
}));

vi.mock("../providers/secrets/index.js", () => ({
  buildSecretCipher: vi.fn(() => ({
    encrypt: vi.fn(),
    decrypt: vi.fn(),
  })),
}));

import { runImport } from "./index.js";
import { createFromBundle } from "./create.js";

let dir: string;
const manifest = {
  bundleVersion: 1,
  source: { product: "agent-cron", exporterVersion: "1.0.0", exportedAt: "2026-09-08T00:00:00.000Z" },
  secretMode: "references",
  transferKeyId: null,
  capabilities: [],
  counts: { agents: 1 },
};
function write(rel: string, obj: unknown) {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(obj));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "import-"));
  write("manifest.json", manifest);
  write("config/agents.json", [
    {
      name: "test-agent",
      systemPrompt: "sp",
      provider: "openai",
      model: "gpt-4o",
      schedule: "",
      scheduleEnabled: true,
      maxTurns: 8,
      budgetUsd: "5.00",
    },
  ]);
  write("config/tools.json", []);
  write("config/agent-tools.json", []);
  write("config/secrets.json", []);
  write("config/agent-secrets.json", []);
  write("config/datastores-single.json", []);
  write("config/webhooks.json", []);
  write("capabilities/budgets.json", []);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("runImport", () => {
  it("dry-run returns a report and performs no writes", async () => {
    const db = {
      agent: { findMany: vi.fn(async () => []), upsert: vi.fn() },
      tool: { findMany: vi.fn(async () => []) },
      secret: { findMany: vi.fn(async () => []) },
      budgetGroup: { findMany: vi.fn(async () => []) },
      principal: { upsert: vi.fn(async () => ({ id: "principal-1", subject: "sub-1" })) },
    } as any;

    const { report, result } = await runImport({
      dir,
      owner: "sub-1",
      isPublic: false,
      includeSecrets: false,
      dryRun: true,
      prefix: "imported-",
      onConflict: "fail",
      allowOpenFetch: false,
      db,
      env: {}, // no LLM creds → routableModels empty → agent disabled
    });
    expect(report).toMatch(/dry.run/i);
    expect(result).toBeUndefined();
    expect(db.agent.upsert).not.toHaveBeenCalled();
  });

  it("errors when neither --owner nor --public is given", async () => {
    await expect(runImport({ owner: null, isPublic: false } as any)).rejects.toThrow(/owner|public/i);
  });

  it("errors when both --owner and --public are given", async () => {
    await expect(runImport({ owner: "sub-1", isPublic: true } as any)).rejects.toThrow(/owner|public/i);
  });

  it("envelope bundle without --include-secrets uses references mode", async () => {
    // Setup envelope bundle
    write("manifest.json", {
      bundleVersion: 1,
      source: { product: "agent-cron", exporterVersion: "1.0.0", exportedAt: "2026-09-08T00:00:00.000Z" },
      secretMode: "envelope",
      transferKeyId: "abc123",
      capabilities: [],
      counts: { agents: 1 },
    });

    const db = {
      agent: { findMany: vi.fn(async () => []), upsert: vi.fn() },
      tool: { findMany: vi.fn(async () => []) },
      secret: { findMany: vi.fn(async () => []) },
      budgetGroup: { findMany: vi.fn(async () => []) },
      principal: { upsert: vi.fn(async () => ({ id: "principal-1", subject: "sub-1" })) },
    } as any;

    vi.mocked(createFromBundle).mockClear();

    await runImport({
      dir,
      owner: "sub-1",
      isPublic: false,
      includeSecrets: false, // omit secrets
      dryRun: false,
      prefix: "imported-",
      onConflict: "fail",
      allowOpenFetch: false,
      db,
      env: {},
    });

    // Should call createFromBundle with references mode and no transfer key
    expect(createFromBundle).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        secretMode: "references",
        transferPrivateKey: undefined,
      }),
    );
  });

  it("envelope bundle with --include-secrets but no --transfer-key throws", async () => {
    // Setup envelope bundle
    write("manifest.json", {
      bundleVersion: 1,
      source: { product: "agent-cron", exporterVersion: "1.0.0", exportedAt: "2026-09-08T00:00:00.000Z" },
      secretMode: "envelope",
      transferKeyId: "abc123",
      capabilities: [],
      counts: { agents: 1 },
    });

    const db = {
      agent: { findMany: vi.fn(async () => []), upsert: vi.fn() },
      tool: { findMany: vi.fn(async () => []) },
      secret: { findMany: vi.fn(async () => []) },
      budgetGroup: { findMany: vi.fn(async () => []) },
      principal: { upsert: vi.fn(async () => ({ id: "principal-1", subject: "sub-1" })) },
    } as any;

    await expect(
      runImport({
        dir,
        owner: "sub-1",
        isPublic: false,
        includeSecrets: true, // want secrets but no key
        // transferKeyPath: undefined, // no key
        dryRun: false,
        prefix: "imported-",
        onConflict: "fail",
        allowOpenFetch: false,
        db,
        env: {},
      }),
    ).rejects.toThrow(/transfer-key/i);
  });
});
