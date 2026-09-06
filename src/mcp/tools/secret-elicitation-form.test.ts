import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { handleSecretElicitationForm, readFormBody } from "./secret-elicitation-form.js";
import type { SecretElicitationPayload } from "./secret-elicitation.js";
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
  const secrets = new Map<string, { id: string; name: string; ciphertext: string; keyId: string; ownerId: string | null; createdAt: Date; updatedAt: Date }>();
  const outcomes = new Map<string, { ownerId: string; secretName: string; outcome: unknown; expiresAt: Date }>();
  let counter = 0;
  return {
    secret: {
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { ownerId_name: { ownerId: string; name: string } };
        create: { name: string; ciphertext: string; keyId: string; ownerId: string };
        update: { ciphertext: string; keyId: string };
      }) => {
        const existing = [...secrets.values()].find((s) => s.ownerId === where.ownerId_name.ownerId && s.name === where.ownerId_name.name);
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
      findUnique: async ({ where: { ownerId_secretName } }: { where: { ownerId_secretName: { ownerId: string; secretName: string } } }) =>
        outcomes.get(`${ownerId_secretName.ownerId}\0${ownerId_secretName.secretName}`) ?? null,
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
  } as unknown as import("@prisma/client").PrismaClient;
}

let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function startTestServer(deps: { verify: (token: string) => Promise<SecretElicitationPayload>; secrets: SecretCipher; db: import("@prisma/client").PrismaClient }) {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    void handleSecretElicitationForm(req.method, url.searchParams.get("t"), () => readFormBody(req), res, deps);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return `http://127.0.0.1:${port}`;
}

describe("handleSecretElicitationForm", () => {
  it("GET with a valid token renders a form naming the secret", async () => {
    const base = await startTestServer({ verify: async () => ({ ownerId: "p1", secretName: "API_KEY" }), secrets: fakeCipher(), db: fakeDb() });
    const res = await fetch(`${base}/secret?t=whatever`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("API_KEY");
    expect(body).toContain("<form");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'none'");
  });

  it("GET with an invalid/expired token shows an error instead of the form", async () => {
    const base = await startTestServer({ verify: async () => { throw new Error("expired"); }, secrets: fakeCipher(), db: fakeDb() });
    const res = await fetch(`${base}/secret?t=bad`);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/expired|invalid/i);
  });

  it("POST with a value creates the secret and returns a success page", async () => {
    const cipher = fakeCipher();
    const db = fakeDb();
    const base = await startTestServer({ verify: async () => ({ ownerId: "p1", secretName: "FORM_TEST_CREATE" }), secrets: cipher, db });
    const res = await fetch(`${base}/secret?t=whatever`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ value: "sk-live-abc123" }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/saved/i);

    const { getSecretElicitationOutcome } = await import("./secret-elicitation.js");
    const outcome = await getSecretElicitationOutcome("p1", "FORM_TEST_CREATE", db);
    expect(outcome).toEqual({ ok: true, secret: expect.objectContaining({ name: "FORM_TEST_CREATE", ownerId: "p1" }) });
  });

  it("POST with no value is rejected without writing a secret", async () => {
    const db = fakeDb();
    const base = await startTestServer({ verify: async () => ({ ownerId: "p1", secretName: "FORM_TEST_EMPTY" }), secrets: fakeCipher(), db });
    const res = await fetch(`${base}/secret?t=whatever`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ value: "" }),
    });
    expect(res.status).toBe(400);
    const { getSecretElicitationOutcome } = await import("./secret-elicitation.js");
    expect(await getSecretElicitationOutcome("p1", "FORM_TEST_EMPTY", db)).toBeUndefined();
  });

  it("resubmitting the same elicitation is idempotent (no second write attempt)", async () => {
    const cipher = fakeCipher();
    const db = fakeDb();
    const base = await startTestServer({ verify: async () => ({ ownerId: "p1", secretName: "FORM_TEST_IDEMPOTENT" }), secrets: cipher, db });
    const submit = () => fetch(`${base}/secret?t=whatever`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ value: "first" }) });
    const first = await submit();
    const second = await submit();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.text()).toMatch(/saved/i);
  });
});
