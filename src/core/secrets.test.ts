import { describe, it, expect } from "vitest";
import {
  createSecret,
  listSecrets,
  attachSecret,
  detachSecret,
  deleteSecret,
  buildSecretsAccessor,
  scopeSecretsAccessor,
} from "./secrets.js";
import type { SecretCipher } from "../providers/secrets/types.js";

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
    decrypt: async (ciphertext) => {
      const plaintext = store.get(ciphertext);
      if (plaintext === undefined) throw new Error("unknown ciphertext");
      return plaintext;
    },
  };
}

interface FakeSecretRow {
  id: string;
  name: string;
  ciphertext: string;
  keyId: string;
  ownerId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
interface FakeAgentSecretRow {
  agentId: string;
  secretId: string;
  boundName: string;
}

function fakeDb() {
  const secrets = new Map<string, FakeSecretRow>();
  const agentSecrets: FakeAgentSecretRow[] = [];
  let counter = 0;

  return {
    secret: {
      create: async ({ data }: { data: Partial<FakeSecretRow> & { name: string } }) => {
        const now = new Date();
        const row: FakeSecretRow = {
          id: `secret_${++counter}`,
          createdAt: now,
          updatedAt: now,
          ownerId: null,
          ...data,
        } as FakeSecretRow;
        secrets.set(row.id, row);
        return row;
      },
      findMany: async ({ where }: { where: { ownerId: string } }) =>
        [...secrets.values()].filter((s) => s.ownerId === where.ownerId),
      findUnique: async ({ where }: { where: { ownerId_name: { ownerId: string; name: string } } }) =>
        [...secrets.values()].find(
          (s) => s.ownerId === where.ownerId_name.ownerId && s.name === where.ownerId_name.name,
        ) ?? null,
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { ownerId_name: { ownerId: string; name: string } };
        create: Partial<FakeSecretRow> & { name: string };
        update: Partial<FakeSecretRow>;
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
        const row: FakeSecretRow = {
          id: `secret_${++counter}`,
          createdAt: now,
          updatedAt: now,
          ownerId: null,
          ...create,
        } as FakeSecretRow;
        secrets.set(row.id, row);
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const row = secrets.get(where.id);
        secrets.delete(where.id);
        return row;
      },
    },
    agentSecret: {
      create: async ({ data }: { data: FakeAgentSecretRow }) => {
        agentSecrets.push(data);
        return data;
      },
      deleteMany: async ({ where }: { where: { agentId: string; boundName: string } }) => {
        const before = agentSecrets.length;
        const kept = agentSecrets.filter((a) => !(a.agentId === where.agentId && a.boundName === where.boundName));
        agentSecrets.length = 0;
        agentSecrets.push(...kept);
        return { count: before - kept.length };
      },
      findFirst: async ({ where }: { where: { agentId: string; boundName: string } }) => {
        const match = agentSecrets.find((a) => a.agentId === where.agentId && a.boundName === where.boundName);
        if (!match) return null;
        return { ...match, secret: secrets.get(match.secretId) };
      },
    },
  } as unknown as import("#prisma").PrismaClient;
}

describe("core/secrets", () => {
  it("createSecret stores ciphertext, not plaintext", async () => {
    const db = fakeDb();
    const cipher = fakeCipher();
    const secret = await createSecret("API_KEY", "sk-live-abc123", "p1", cipher, db);
    expect(secret.ciphertext).not.toBe("sk-live-abc123");
    expect(secret.name).toBe("API_KEY");
  });

  it("createSecret upserts: calling it again for the same owner+name rotates the value instead of throwing", async () => {
    const db = fakeDb();
    const cipher = fakeCipher();
    const first = await createSecret("API_KEY", "sk-live-old", "p1", cipher, db);
    const second = await createSecret("API_KEY", "sk-live-new", "p1", cipher, db);

    expect(second.id).toBe(first.id);
    const list = await listSecrets("p1", db);
    expect(list.length).toBe(1);

    await attachSecret("agent-1", "API_KEY", "p1", db);
    const accessor = buildSecretsAccessor("agent-1", cipher, db);
    expect(await accessor.get("API_KEY")).toBe("sk-live-new");
  });

  it("listSecrets never includes value or ciphertext", async () => {
    const db = fakeDb();
    const cipher = fakeCipher();
    await createSecret("API_KEY", "sk-live-abc123", "p1", cipher, db);
    const list = await listSecrets("p1", db);
    expect(list.length).toBe(1);
    expect(list[0]).not.toHaveProperty("value");
    expect(list[0]).not.toHaveProperty("ciphertext");
    expect(list[0].name).toBe("API_KEY");
  });

  it("round-trips: attach then buildSecretsAccessor().get() decrypts at use", async () => {
    const db = fakeDb();
    const cipher = fakeCipher();
    await createSecret("API_KEY", "sk-live-abc123", "p1", cipher, db);
    await attachSecret("agent-1", "API_KEY", "p1", db);

    const accessor = buildSecretsAccessor("agent-1", cipher, db);
    expect(await accessor.get("API_KEY")).toBe("sk-live-abc123");
  });

  it("buildSecretsAccessor().get() returns undefined for an unattached name", async () => {
    const db = fakeDb();
    const cipher = fakeCipher();
    await createSecret("API_KEY", "sk-live-abc123", "p1", cipher, db);
    // never attached to agent-1

    const accessor = buildSecretsAccessor("agent-1", cipher, db);
    expect(await accessor.get("API_KEY")).toBeUndefined();
  });

  it("detachSecret removes access", async () => {
    const db = fakeDb();
    const cipher = fakeCipher();
    await createSecret("API_KEY", "sk-live-abc123", "p1", cipher, db);
    await attachSecret("agent-1", "API_KEY", "p1", db);
    await detachSecret("agent-1", "API_KEY", db);

    const accessor = buildSecretsAccessor("agent-1", cipher, db);
    expect(await accessor.get("API_KEY")).toBeUndefined();
  });

  it("two agents resolve the same boundName to their own distinct secrets", async () => {
    const db = fakeDb();
    const cipher = fakeCipher();
    await createSecret("bitbucket_aies", "token-aies", "p1", cipher, db);
    await createSecret("bitbucket_ondemand", "token-ondemand", "p1", cipher, db);
    await attachSecret("agent-A", "bitbucket_aies", "p1", db, "bitbucket");
    await attachSecret("agent-B", "bitbucket_ondemand", "p1", db, "bitbucket");

    expect(await buildSecretsAccessor("agent-A", cipher, db).get("bitbucket")).toBe("token-aies");
    expect(await buildSecretsAccessor("agent-B", cipher, db).get("bitbucket")).toBe("token-ondemand");
  });

  it("one agent resolves two secrets under two distinct boundNames", async () => {
    const db = fakeDb();
    const cipher = fakeCipher();
    await createSecret("jira_chris", "jc", "p1", cipher, db);
    await createSecret("bitbucket_aies", "ba", "p1", cipher, db);
    await attachSecret("agent-1", "jira_chris", "p1", db, "jira");
    await attachSecret("agent-1", "bitbucket_aies", "p1", db, "bitbucket");

    const accessor = buildSecretsAccessor("agent-1", cipher, db);
    expect(await accessor.get("jira")).toBe("jc");
    expect(await accessor.get("bitbucket")).toBe("ba");
  });

  it("attachSecret defaults boundName to the secret name", async () => {
    const db = fakeDb();
    const cipher = fakeCipher();
    await createSecret("API_KEY", "v", "p1", cipher, db);
    await attachSecret("agent-1", "API_KEY", "p1", db);
    expect(await buildSecretsAccessor("agent-1", cipher, db).get("API_KEY")).toBe("v");
  });

  it("deleteSecret removes it from listSecrets", async () => {
    const db = fakeDb();
    const cipher = fakeCipher();
    const secret = await createSecret("API_KEY", "sk-live-abc123", "p1", cipher, db);
    await deleteSecret(secret.id, db);
    const list = await listSecrets("p1", db);
    expect(list.length).toBe(0);
  });
});

describe("scopeSecretsAccessor", () => {
  function fakeAccessor(values: Record<string, string>) {
    return {
      async get(name: string) {
        return values[name];
      },
    };
  }

  it("resolves a name that is in the allowlist", async () => {
    const scoped = scopeSecretsAccessor(fakeAccessor({ ALLOWED: "v1", BLOCKED: "v2" }), ["ALLOWED"]);
    await expect(scoped.get("ALLOWED")).resolves.toBe("v1");
  });

  it("resolves undefined for a name that exists on the underlying accessor but is not in the allowlist", async () => {
    const scoped = scopeSecretsAccessor(fakeAccessor({ ALLOWED: "v1", BLOCKED: "v2" }), ["ALLOWED"]);
    await expect(scoped.get("BLOCKED")).resolves.toBeUndefined();
  });

  it("never calls the underlying accessor for a disallowed name", async () => {
    let calls = 0;
    const accessor = {
      async get(_name: string) {
        calls++;
        return "x";
      },
    };
    const scoped = scopeSecretsAccessor(accessor, []);
    await scoped.get("ANYTHING");
    expect(calls).toBe(0);
  });

  it("resolves undefined for every name when the allowlist is empty", async () => {
    const scoped = scopeSecretsAccessor(fakeAccessor({ A: "1" }), []);
    await expect(scoped.get("A")).resolves.toBeUndefined();
  });
});
