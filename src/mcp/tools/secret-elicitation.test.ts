import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getSecretElicitationOutcome,
  fulfillSecretElicitation,
  fulfillUnbrokerElicitation,
  type SecretElicitationPayload,
} from "./secret-elicitation.js";
import type { SecretCipher } from "../../providers/secrets/types.js";

function fakeCipher(): SecretCipher {
  const store = new Map<string, string>();
  let counter = 0;
  return {
    keyId: () => "appkey:fake",
    encrypt: async (plaintext) => {
      const id = `ct_${++counter}`;
      store.set(id, plaintext);
      return id;
    },
    decrypt: async (ciphertext) => store.get(ciphertext) ?? "",
  };
}

function fakeDb() {
  const secrets = new Map<
    string,
    {
      id: string;
      name: string;
      ciphertext: string;
      keyId: string;
      ownerId: string | null;
      createdAt: Date;
      updatedAt: Date;
    }
  >();
  const outcomes = new Map<string, { ownerId: string; secretName: string; outcome: unknown; expiresAt: Date }>();
  let counter = 0;
  return {
    secret: {
      findUnique: async () => null,
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { ownerId_name: { ownerId: string; name: string } };
        create: { name: string; ciphertext: string; keyId: string; ownerId: string };
        update: { ciphertext: string; keyId: string };
      }) => {
        const existing = [...secrets.values()].find(
          (s) => s.ownerId === where.ownerId_name.ownerId && s.name === where.ownerId_name.name,
        );
        if (existing) {
          const row = { ...existing, ...update, updatedAt: new Date() };
          secrets.set(row.id, row);
          return row;
        }
        const now = new Date();
        const row = { id: `secret_${++counter}`, createdAt: now, updatedAt: now, ...create };
        secrets.set(row.id, row);
        return row;
      },
    },
    secretElicitationOutcome: {
      findUnique: async ({
        where: { ownerId_secretName },
      }: {
        where: { ownerId_secretName: { ownerId: string; secretName: string } };
      }) => outcomes.get(`${ownerId_secretName.ownerId}\0${ownerId_secretName.secretName}`) ?? null,
      upsert: async ({
        where: { ownerId_secretName },
        create,
        update,
      }: {
        where: { ownerId_secretName: { ownerId: string; secretName: string } };
        create: { ownerId: string; secretName: string; outcome: unknown; expiresAt: Date };
        update: { outcome: unknown; expiresAt: Date };
      }) => {
        const key = `${ownerId_secretName.ownerId}\0${ownerId_secretName.secretName}`;
        const existing = outcomes.get(key);
        const row = existing ? { ...existing, ...update } : create;
        outcomes.set(key, row);
        return row;
      },
      deleteMany: async ({ where: { expiresAt } }: { where: { expiresAt: { lte: Date } } }) => {
        let count = 0;
        for (const [key, row] of outcomes) {
          if (row.expiresAt <= expiresAt.lte) {
            outcomes.delete(key);
            count++;
          }
        }
        return { count };
      },
    },
  } as unknown as import("#prisma").PrismaClient;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("secret elicitation outcome TTL", () => {
  it("evicts an outcome once its TTL has elapsed", async () => {
    vi.useFakeTimers();
    const db = fakeDb();
    const payload: SecretElicitationPayload = { ownerId: "p1", secretName: "TTL_TEST" };
    await fulfillSecretElicitation(payload, "value", fakeCipher(), db);
    expect(await getSecretElicitationOutcome("p1", "TTL_TEST", db)).toEqual({
      ok: true,
      kind: "create",
      secret: expect.objectContaining({ name: "TTL_TEST" }),
    });

    vi.advanceTimersByTime(600_001);
    expect(await getSecretElicitationOutcome("p1", "TTL_TEST", db)).toBeUndefined();
  });

  it("a later unrelated lookup prunes an earlier expired entry even without ever re-reading it", async () => {
    vi.useFakeTimers();
    const cipher = fakeCipher();
    const db = fakeDb();
    await fulfillSecretElicitation({ ownerId: "p1", secretName: "STALE" }, "value", cipher, db);

    vi.advanceTimersByTime(600_001);
    // Never re-read STALE directly — only a fresh, unrelated elicitation triggers the sweep.
    await fulfillSecretElicitation({ ownerId: "p1", secretName: "FRESH" }, "value2", cipher, db);

    expect(await getSecretElicitationOutcome("p1", "STALE", db)).toBeUndefined();
    expect(await getSecretElicitationOutcome("p1", "FRESH", db)).toEqual({
      ok: true,
      kind: "create",
      secret: expect.objectContaining({ name: "FRESH" }),
    });
  });

  it("still returns the recorded outcome, and skips a second write, within the TTL window", async () => {
    vi.useFakeTimers();
    const cipher = fakeCipher();
    const db = fakeDb();
    const first = await fulfillSecretElicitation({ ownerId: "p1", secretName: "IDEMPOTENT_TTL" }, "first", cipher, db);

    vi.advanceTimersByTime(500_000);
    const second = await fulfillSecretElicitation(
      { ownerId: "p1", secretName: "IDEMPOTENT_TTL" },
      "second",
      cipher,
      db,
    );

    expect(second).toEqual(first);
  });
});

describe("secret elicitation outcome kind", () => {
  async function store(db: import("#prisma").PrismaClient, outcome: unknown) {
    await db.secretElicitationOutcome.upsert({
      where: { ownerId_secretName: { ownerId: "p1", secretName: "K" } },
      create: { ownerId: "p1", secretName: "K", outcome: outcome as never, expiresAt: new Date(Date.now() + 60_000) },
      update: { outcome: outcome as never, expiresAt: new Date(Date.now() + 60_000) },
    });
  }

  it("an unbroker outcome answers only an unbroker lookup", async () => {
    const db = fakeDb();
    const outcome = { ok: false, kind: "unbroker", error: "secret_not_found: x" };
    await store(db, outcome);
    expect(await getSecretElicitationOutcome("p1", "K", db)).toBeUndefined();
    expect(await getSecretElicitationOutcome("p1", "K", db, "create")).toBeUndefined();
    expect(await getSecretElicitationOutcome("p1", "K", db, "unbroker")).toEqual(outcome);
  });

  it("a legacy outcome without kind counts as a create", async () => {
    const db = fakeDb();
    const legacy = { ok: false, error: "boom" };
    await store(db, legacy);
    expect(await getSecretElicitationOutcome("p1", "K", db)).toEqual(legacy);
    expect(await getSecretElicitationOutcome("p1", "K", db, "unbroker")).toBeUndefined();
  });

  it("a stale unbroker outcome does not short-circuit a create", async () => {
    const db = fakeDb();
    await store(db, { ok: false, kind: "unbroker", error: "stale" });
    const outcome = await fulfillSecretElicitation({ ownerId: "p1", secretName: "K" }, "value", fakeCipher(), db);
    expect(outcome).toEqual({ ok: true, kind: "create", secret: expect.objectContaining({ name: "K", broker: null }) });
  });

  it("a payload minted before kind existed is a create", async () => {
    const db = fakeDb();
    const legacyPayload = { ownerId: "p1", secretName: "OLD" } as SecretElicitationPayload;
    const outcome = await fulfillSecretElicitation(legacyPayload, "value", fakeCipher(), db);
    expect(outcome).toMatchObject({ ok: true, kind: "create" });
  });

  it("each fulfil refuses the other kind's link without writing anything", async () => {
    const db = fakeDb();
    const cipher = fakeCipher();
    const asCreate = await fulfillSecretElicitation(
      { ownerId: "p1", secretName: "K", kind: "unbroker" },
      "value",
      cipher,
      db,
    );
    expect(asCreate).toMatchObject({
      ok: false,
      kind: "create",
      error: expect.stringMatching(/elicitation_kind_mismatch/),
    });
    const asUnbroker = await fulfillUnbrokerElicitation({ ownerId: "p1", secretName: "K" }, cipher, db);
    expect(asUnbroker).toMatchObject({
      ok: false,
      kind: "unbroker",
      error: expect.stringMatching(/elicitation_kind_mismatch/),
    });
    expect(await getSecretElicitationOutcome("p1", "K", db)).toBeUndefined();
    expect(await getSecretElicitationOutcome("p1", "K", db, "unbroker")).toBeUndefined();
  });
});
