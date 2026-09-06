import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { PostgresDatastore } from "./postgres.js";
import { AppKeySecretCipher } from "../secrets/app-key.js";

const databaseUrl = process.env.DATABASE_URL;
const cipherKey = "0".repeat(64); // 32 bytes hex

if (!databaseUrl) {
  console.warn(
    "[reevo-run tests] DATABASE_URL not set — skipping PostgresDatastore tests " +
      "(get/set/delete/list round-trip, per-agent scoping). Set DATABASE_URL to run them.",
  );
}

describe.skipIf(!databaseUrl)("PostgresDatastore (database)", () => {
  const prisma = new PrismaClient();
  const datastore = new PostgresDatastore(prisma);
  const agentIds: string[] = [];

  function newAgentId(): string {
    const id = `datastore-test-${randomUUID()}`;
    agentIds.push(id);
    return id;
  }

  afterAll(async () => {
    await prisma.datastoreEntry.deleteMany({ where: { agentId: { in: agentIds } } });
    await prisma.$disconnect();
  });

  it("returns undefined for a key that was never set", async () => {
    const agentId = newAgentId();
    expect(await datastore.get(agentId, "missing")).toBeUndefined();
  });
  it("rejects oversized new values and filters oversized legacy values inside PostgreSQL", async () => {
    const agentId = newAgentId();
    await expect(datastore.set(agentId, "big", "x".repeat(1024 * 1024 + 1))).rejects.toThrow(/limit/);
    await prisma.datastoreEntry.create({ data: { agentId, key: "legacy", value: "x".repeat(1024 * 1024 + 1) } });
    await expect(datastore.get(agentId, "legacy")).rejects.toThrow("datastore_value_limit");
    await prisma.datastoreEntry.create({ data: { agentId, key: "k".repeat(1025), value: null as never } });
    await expect(datastore.list(agentId)).rejects.toThrow("datastore_list_limit");
  });

  it("round-trips get/set/delete", async () => {
    const agentId = newAgentId();

    await datastore.set(agentId, "greeting", { hello: "world" });
    expect(await datastore.get(agentId, "greeting")).toEqual({ hello: "world" });

    await datastore.set(agentId, "greeting", "updated");
    expect(await datastore.get(agentId, "greeting")).toBe("updated");

    await datastore.delete(agentId, "greeting");
    expect(await datastore.get(agentId, "greeting")).toBeUndefined();
  });

  it("lists keys, optionally filtered by prefix, sorted", async () => {
    const agentId = newAgentId();
    await datastore.set(agentId, "user:1", "a");
    await datastore.set(agentId, "user:2", "b");
    await datastore.set(agentId, "config:theme", "dark");

    expect(await datastore.list(agentId)).toEqual(["config:theme", "user:1", "user:2"]);
    expect(await datastore.list(agentId, "user:")).toEqual(["user:1", "user:2"]);
  });

  it("scopes entries per agent — one agent can't read another's keys", async () => {
    const agentA = newAgentId();
    const agentB = newAgentId();

    await datastore.set(agentA, "secret", "a-only");

    expect(await datastore.get(agentB, "secret")).toBeUndefined();
    expect(await datastore.list(agentB)).toEqual([]);
    expect(await datastore.get(agentA, "secret")).toBe("a-only");
  });

  describe("pii: true", () => {
    const cipher = new AppKeySecretCipher(cipherKey);
    const encrypted = new PostgresDatastore(prisma, cipher);

    it("stores the value encrypted at rest and decrypts it back on get", async () => {
      const agentId = newAgentId();
      await encrypted.set(agentId, "ssn", { value: "123-45-6789" }, { pii: true });

      const raw = await prisma.datastoreEntry.findUniqueOrThrow({ where: { agentId_key: { agentId, key: "ssn" } } });
      expect(raw.pii).toBe(true);
      expect(raw.keyId).toBe(cipher.keyId());
      expect(JSON.stringify(raw.value)).not.toContain("123-45-6789");

      expect(await encrypted.get(agentId, "ssn")).toEqual({ value: "123-45-6789" });
    });

    it("a pii:false (default) entry is stored and readable as plain JSON, unaffected by an available cipher", async () => {
      const agentId = newAgentId();
      await encrypted.set(agentId, "plain", { value: "not sensitive" });

      const raw = await prisma.datastoreEntry.findUniqueOrThrow({ where: { agentId_key: { agentId, key: "plain" } } });
      expect(raw.pii).toBe(false);
      expect(raw.keyId).toBeNull();
      expect(await encrypted.get(agentId, "plain")).toEqual({ value: "not sensitive" });
    });

    it("throws rather than silently storing/reading plaintext when no cipher is configured", async () => {
      const agentId = newAgentId();
      await expect(datastore.set(agentId, "ssn", "123-45-6789", { pii: true })).rejects.toThrow("datastore_pii_cipher_unavailable");

      await prisma.datastoreEntry.create({ data: { agentId, key: "orphaned-pii", value: "some-ciphertext", pii: true, keyId: "appkey:whatever" } });
      await expect(datastore.get(agentId, "orphaned-pii")).rejects.toThrow("datastore_pii_cipher_unavailable");
    });
  });
});
