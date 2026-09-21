import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync, diffieHellman, hkdfSync, randomBytes, createCipheriv, type KeyObject } from "node:crypto";
import { createFromBundle } from "./create.js";
import type { Bundle } from "./bundle.js";
import type { Reconciliation } from "./preflight.js";
import type { TransferEnvelope } from "../providers/secrets/transfer-envelope.js";

const INFO = Buffer.from("wardby-secret-transfer-v1");
const rawOf = (k: KeyObject) => (k.export({ type: "spki", format: "der" }) as Buffer).subarray(-32);

// Test-only sealer matching spec §5.3 (mirrors the exporter).
function seal(plaintext: string, name: string, recipientPub: KeyObject): TransferEnvelope {
  const { privateKey: esk, publicKey: epk } = generateKeyPairSync("x25519");
  const epkRaw = rawOf(epk);
  const shared = diffieHellman({ privateKey: esk, publicKey: recipientPub });
  const okm = Buffer.from(hkdfSync("sha256", shared, Buffer.concat([epkRaw, rawOf(recipientPub)]), INFO, 32));
  const nonce = randomBytes(12);
  const c = createCipheriv("chacha20-poly1305", okm, nonce, { authTagLength: 16 });
  c.setAAD(Buffer.from(name, "utf8"), { plaintextLength: Buffer.byteLength(plaintext) });
  const ct = Buffer.concat([c.update(Buffer.from(plaintext, "utf8")), c.final()]);
  return {
    v: 1,
    alg: "x25519-hkdf-sha256-chacha20poly1305-v1",
    epk: epkRaw.toString("hex"),
    nonce: nonce.toString("hex"),
    ct: ct.toString("hex"),
    tag: c.getAuthTag().toString("hex"),
  };
}

// Minimal fake db capturing calls; enough to prove references-mode creates no secrets
// and envelope-mode decrypts. Real coverage is in create.database.test.ts.
function fakeDb() {
  const calls: Record<string, unknown[]> = { tool: [], agent: [], secret: [], agentSecret: [], webhook: [] };
  return {
    calls,
    tool: {
      upsert: vi.fn(async (a: unknown) => {
        calls.tool.push(a);
        return { id: "t", name: "n" };
      }),
    },
    agent: {
      upsert: vi.fn(async (a: unknown) => {
        calls.agent.push(a);
        return { id: "a", name: "n" };
      }),
      update: vi.fn(async () => ({})),
    },
    agentTool: { upsert: vi.fn(async () => ({})) },
    secret: {
      upsert: vi.fn(async (a: unknown) => {
        calls.secret.push(a);
        return { id: "s", name: "n" };
      }),
      findUnique: vi.fn(async () => ({ id: "s", name: "n" })),
    },
    agentSecret: {
      create: vi.fn(async (a: unknown) => {
        calls.agentSecret.push(a);
        return {};
      }),
      findFirst: vi.fn(async () => null),
    },
    budgetGroup: { upsert: vi.fn(async () => ({ id: "b" })) },
    webhook: { findFirst: vi.fn(async () => null), update: vi.fn(async () => ({})) },
    datastoreEntry: { upsert: vi.fn(async () => ({})) },
  } as any;
}
const emptyRecon: Reconciliation = {
  nameRemap: new Map(),
  agents: [],
  tools: [],
  skippedCapabilities: [],
  budgets: [],
  collisions: [],
  notes: [],
  hasFatalCollision: false,
};

function bundleWith(over: Partial<Record<string, unknown[]>>): Bundle {
  const rd = (k: string) => () => (over[k] as any) ?? [];
  return {
    manifest: {} as any,
    readAgents: rd("agents"),
    readTools: rd("tools"),
    readAgentTools: rd("agentTools"),
    readSecrets: rd("secrets"),
    readAgentSecrets: rd("agentSecrets"),
    readSingleDatastores: rd("datastores"),
    readSharedDatastores: rd("sharedDatastores"),
    readWebhooks: rd("webhooks"),
    readBudgets: rd("budgets"),
  };
}
const cipher = { keyId: () => "appkey:test", encrypt: async (s: string) => `E::${s}`, decrypt: async (s: string) => s };

describe("createFromBundle", () => {
  it("references mode: creates no secrets, lists them as pending", async () => {
    const db = fakeDb();
    const res = await createFromBundle(
      bundleWith({ secrets: [{ name: "API_KEY", description: null, ownerEmail: null }] }),
      emptyRecon,
      { db, cipher, ownerId: "p1", defaultBudget: "5.00", secretMode: "references", allowOpenFetch: false } as any,
    );
    expect(res.secretsCreated).toBe(0);
    expect(res.pendingSecretReentry).toContain("API_KEY");
  });

  it("envelope mode: decrypts with AAD=secretName, creates one base row, attaches under the alias", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    const db = fakeDb();

    const ciphertext = seal("my-secret-value", "API_KEY", publicKey);

    const res = await createFromBundle(
      bundleWith({
        agents: [{ name: "test-agent" }],
        secrets: [{ name: "API_KEY", description: null, ownerEmail: null, ciphertext }],
        agentSecrets: [{ agentName: "test-agent", secretName: "API_KEY", alias: "AK" }],
      }),
      emptyRecon,
      {
        db,
        cipher,
        ownerId: "p1",
        defaultBudget: "5.00",
        secretMode: "envelope",
        transferPrivateKey: privateKey,
        allowOpenFetch: false,
      } as any,
    );

    // One base-name secret row, counted once.
    expect(res.secretsCreated).toBe(1);
    expect(db.calls.secret).toHaveLength(1);
    expect(db.calls.secret[0].where.ownerId_name.name).toBe("API_KEY");

    // Attachment carries the alias as the point-of-use boundName.
    expect(db.calls.agentSecret).toHaveLength(1);
    expect(db.calls.agentSecret[0].data.boundName).toBe("AK");

    // No "created under both base name and alias" warning anymore.
    expect(res.warnings.some((w) => w.includes("created under both base name and alias"))).toBe(false);
  });

  it("public import (ownerId: null): creates agents/tools, skips owner-required entities with warnings", async () => {
    const db = fakeDb();

    const res = await createFromBundle(
      bundleWith({
        agents: [{ name: "public-agent" }],
        tools: [{ name: "public-tool", code: "code", paramsZod: "z.object({})", description: "" }],
        webhooks: [{ agentName: "public-agent", enabled: true }],
        budgets: [
          {
            name: "monthly-budget",
            period: "monthly",
            alertThreshold: "80",
            blockThreshold: "100",
            enabled: true,
            attachedAgentNames: ["public-agent"],
          },
        ],
        agentSecrets: [{ agentName: "public-agent", secretName: "API_KEY", alias: null }],
      }),
      emptyRecon,
      { db, cipher, ownerId: null, defaultBudget: "5.00", secretMode: "references", allowOpenFetch: false } as any,
    );

    // Assert: agents and tools created (public entities)
    expect(res.agentsCreated).toBe(1);
    expect(res.toolsCreated).toBe(1);
    expect(db.calls.agent).toHaveLength(1);
    expect(db.calls.tool).toHaveLength(1);

    // Assert: owner-required entities skipped
    expect(res.webhookSecrets).toHaveLength(0);
    expect(res.budgetGroupsCreated).toBe(0);

    // Assert: warnings present for skipped entities
    expect(
      res.warnings.some((w) => w.includes("webhook for agent public-agent: skipped — webhooks require an owner")),
    ).toBe(true);
    expect(
      res.warnings.some((w) => w.includes("budget group monthly-budget: skipped — budget groups require an owner")),
    ).toBe(true);
  });
});
