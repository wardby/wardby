import { describe, it, expect } from "vitest";
import { createStdioSecretElicitationHost } from "./secret-elicitation-server.js";
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
  const secrets = new Map<string, unknown>();
  let counter = 0;
  return {
    secret: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        const row = { id: `secret_${++counter}`, createdAt: new Date(), updatedAt: new Date(), ...create };
        secrets.set(row.id, row);
        return row;
      },
    },
  } as unknown as import("#prisma").PrismaClient;
}

describe("createStdioSecretElicitationHost", () => {
  it("lazily starts a loopback server and serves the form at the returned URL", async () => {
    const payload: SecretElicitationPayload = { ownerId: "p1", secretName: "API_KEY" };
    const host = createStdioSecretElicitationHost({
      verify: async (token) => (token === "good" ? payload : Promise.reject(new Error("bad"))),
      secrets: fakeCipher(),
      db: fakeDb(),
    });

    const url = await host.urlFor("good");
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/secret\?t=good$/);

    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("API_KEY");
  });

  it("reuses the same server/port across multiple tokens", async () => {
    const host = createStdioSecretElicitationHost({
      verify: async () => ({ ownerId: "p1", secretName: "X" }),
      secrets: fakeCipher(),
      db: fakeDb(),
    });
    const first = await host.urlFor("t1");
    const second = await host.urlFor("t2");
    expect(new URL(first).port).toBe(new URL(second).port);
  });

  it("404s any path other than /secret", async () => {
    const host = createStdioSecretElicitationHost({
      verify: async () => ({ ownerId: "p1", secretName: "X" }),
      secrets: fakeCipher(),
      db: fakeDb(),
    });
    const url = await host.urlFor("good");
    const other = new URL(url);
    other.pathname = "/other";
    const res = await fetch(other);
    expect(res.status).toBe(404);
  });

  it("answers an oversize POST with 413 and keeps serving", async () => {
    const host = createStdioSecretElicitationHost({
      verify: async () => ({ ownerId: "p1", secretName: "BIG" }),
      secrets: fakeCipher(),
      db: fakeDb(),
    });
    const url = await host.urlFor("good");
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ value: "x".repeat(40 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect((await fetch(url)).status).toBe(200);
  });

  it("a handler failure ends the response with 500 instead of an unhandled rejection", async () => {
    // This fake db has no secret.findMany, so rendering the unbroker page throws.
    const host = createStdioSecretElicitationHost({
      verify: async () => ({ ownerId: "p1", secretName: "GH", kind: "unbroker", brokerHash: "h" }),
      secrets: fakeCipher(),
      db: fakeDb(),
    });
    const url = await host.urlFor("good");
    const res = await fetch(url);
    expect(res.status).toBe(500);
    expect((await fetch(url)).status).toBe(500);
  });
});
