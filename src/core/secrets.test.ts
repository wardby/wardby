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

/** Every agent these tests use is owned by p1 unless a test says otherwise. */
const DEFAULT_AGENT_OWNERS: Record<string, string | null> = { "agent-1": "p1", "agent-A": "p1", "agent-B": "p1" };

function fakeDb(agentOwners: Record<string, string | null> = DEFAULT_AGENT_OWNERS) {
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
      deleteMany: async ({ where }: { where: { agentId: string; boundName?: string; secret?: { name: string } } }) => {
        const matches = (a: FakeAgentSecretRow) =>
          a.agentId === where.agentId &&
          (where.boundName === undefined || a.boundName === where.boundName) &&
          (where.secret === undefined || secrets.get(a.secretId)?.name === where.secret.name);
        const before = agentSecrets.length;
        const kept = agentSecrets.filter((a) => !matches(a));
        agentSecrets.length = 0;
        agentSecrets.push(...kept);
        return { count: before - kept.length };
      },
      findFirst: async ({ where }: { where: { agentId: string; boundName: string } }) => {
        const match = agentSecrets.find((a) => a.agentId === where.agentId && a.boundName === where.boundName);
        if (!match) return null;
        return {
          ...match,
          secret: secrets.get(match.secretId),
          agent: { ownerId: agentOwners[match.agentId] ?? null },
        };
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
    expect(await detachSecret("agent-1", "API_KEY", db)).toBe(1);

    const accessor = buildSecretsAccessor("agent-1", cipher, db);
    expect(await accessor.get("API_KEY")).toBeUndefined();
  });

  it("detachSecret also accepts the secret's own name when it was attached under an alias", async () => {
    const db = fakeDb();
    const cipher = fakeCipher();
    await createSecret("REVIEW_GITHUB_TOKEN", "ghp-abc", "p1", cipher, db);
    await attachSecret("agent-1", "REVIEW_GITHUB_TOKEN", "p1", db, "GITHUB_TOKEN");

    expect(await detachSecret("agent-1", "REVIEW_GITHUB_TOKEN", db)).toBe(1);
    expect(await buildSecretsAccessor("agent-1", cipher, db).get("GITHUB_TOKEN")).toBeUndefined();
  });

  it("detachSecret prefers the alias over another secret's own name", async () => {
    const db = fakeDb();
    const cipher = fakeCipher();
    await createSecret("TOKEN", "value-a", "p1", cipher, db);
    await createSecret("OTHER", "value-b", "p1", cipher, db);
    // "TOKEN" is secret TOKEN's own name AND the alias OTHER is attached under.
    await attachSecret("agent-1", "TOKEN", "p1", db, "X");
    await attachSecret("agent-1", "OTHER", "p1", db, "TOKEN");

    expect(await detachSecret("agent-1", "TOKEN", db)).toBe(1);
    const accessor = buildSecretsAccessor("agent-1", cipher, db);
    expect(await accessor.get("TOKEN")).toBeUndefined();
    expect(await accessor.get("X")).toBe("value-a");
  });

  it("detachSecret returns 0 when nothing matches", async () => {
    const db = fakeDb();
    const cipher = fakeCipher();
    await createSecret("API_KEY", "sk-live-abc123", "p1", cipher, db);
    await attachSecret("agent-1", "API_KEY", "p1", db);

    expect(await detachSecret("agent-1", "NOPE", db)).toBe(0);
    expect(await buildSecretsAccessor("agent-1", cipher, db).get("API_KEY")).toBe("sk-live-abc123");
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

  it("A2/S2-2: cross-owner binding is inert at run time (Prisma fallback)", async () => {
    // A row written before the fix (or left behind by make_owner): p2's
    // secret bound to p1's agent. It must resolve like an unattached name.
    const db = fakeDb({ "agent-1": "p1" });
    const cipher = fakeCipher();
    await createSecret("TOKEN", "p2-secret", "p2", cipher, db);
    await attachSecret("agent-1", "TOKEN", "p2", db);
    expect(await buildSecretsAccessor("agent-1", cipher, db).get("TOKEN")).toBeUndefined();
  });

  it("an owner-less agent resolves no owned secret (Prisma fallback)", async () => {
    const db = fakeDb({ "agent-1": null });
    const cipher = fakeCipher();
    await createSecret("TOKEN", "p1-secret", "p1", cipher, db);
    await attachSecret("agent-1", "TOKEN", "p1", db);
    expect(await buildSecretsAccessor("agent-1", cipher, db).get("TOKEN")).toBeUndefined();
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
