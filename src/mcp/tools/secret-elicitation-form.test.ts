import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import {
  brokerConfigFromForm,
  brokerFieldset,
  handleSecretElicitationForm,
  readFormBody,
} from "./secret-elicitation-form.js";
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

function fakeDb(seed: { name: string; ownerId: string; broker: unknown }[] = []) {
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
      broker?: unknown;
    }
  >();
  for (const [i, s] of seed.entries()) {
    const now = new Date();
    secrets.set(`seed_${i}`, { id: `seed_${i}`, ciphertext: "ct", keyId: "k", createdAt: now, updatedAt: now, ...s });
  }
  const outcomes = new Map<string, { ownerId: string; secretName: string; outcome: unknown; expiresAt: Date }>();
  let counter = 0;
  return {
    secret: {
      findUnique: async () => null,
      findMany: async ({ where: { ownerId } }: { where: { ownerId: string } }) =>
        [...secrets.values()].filter((s) => s.ownerId === ownerId),
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

let server: Server | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

async function startTestServer(deps: {
  verify: (token: string) => Promise<SecretElicitationPayload>;
  secrets: SecretCipher;
  db: import("#prisma").PrismaClient;
}) {
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
    const base = await startTestServer({
      verify: async () => ({ ownerId: "p1", secretName: "API_KEY" }),
      secrets: fakeCipher(),
      db: fakeDb(),
    });
    const res = await fetch(`${base}/secret?t=whatever`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("API_KEY");
    expect(body).toContain("<form");
    expect(res.headers.get("content-security-policy")).toContain("script-src 'none'");
  });

  it("uses a referrer policy under which the form's native POST keeps its Origin", async () => {
    // Under no-referrer a browser sends `Origin: null` on a native form POST, even
    // to the same origin, and the HTTP transport rejects that as invalid_origin.
    const base = await startTestServer({
      verify: async () => ({ ownerId: "p1", secretName: "API_KEY" }),
      secrets: fakeCipher(),
      db: fakeDb(),
    });
    const res = await fetch(`${base}/secret?t=whatever`);
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
  });

  it("GET with an invalid/expired token shows an error instead of the form", async () => {
    const base = await startTestServer({
      verify: async () => {
        throw new Error("expired");
      },
      secrets: fakeCipher(),
      db: fakeDb(),
    });
    const res = await fetch(`${base}/secret?t=bad`);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/expired|invalid/i);
  });

  it("POST with a value creates the secret and returns a success page", async () => {
    const cipher = fakeCipher();
    const db = fakeDb();
    const base = await startTestServer({
      verify: async () => ({ ownerId: "p1", secretName: "FORM_TEST_CREATE" }),
      secrets: cipher,
      db,
    });
    const res = await fetch(`${base}/secret?t=whatever`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ value: "sk-live-abc123" }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toMatch(/saved/i);

    const { getSecretElicitationOutcome } = await import("./secret-elicitation.js");
    const outcome = await getSecretElicitationOutcome("p1", "FORM_TEST_CREATE", db);
    expect(outcome).toEqual({
      ok: true,
      kind: "create",
      secret: expect.objectContaining({ name: "FORM_TEST_CREATE", ownerId: "p1" }),
    });
  });

  it("POST with no value is rejected without writing a secret", async () => {
    const db = fakeDb();
    const base = await startTestServer({
      verify: async () => ({ ownerId: "p1", secretName: "FORM_TEST_EMPTY" }),
      secrets: fakeCipher(),
      db,
    });
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
    const base = await startTestServer({
      verify: async () => ({ ownerId: "p1", secretName: "FORM_TEST_IDEMPOTENT" }),
      secrets: cipher,
      db,
    });
    const submit = () =>
      fetch(`${base}/secret?t=whatever`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ value: "first" }),
      });
    const first = await submit();
    const second = await submit();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.text()).toMatch(/saved/i);
  });

  const BROKER = {
    hosts: ["api.github.com"],
    placement: { kind: "header" as const, name: "Authorization", format: "Bearer {value}" },
  };
  const WARNING =
    "If this is not brokered, any tool attached with this secret can read its value and send it anywhere that tool can fetch";

  it("GET create page has the brokered checkbox, the warning, and the compatibility note — and no script", async () => {
    const base = await startTestServer({
      verify: async () => ({ ownerId: "p1", secretName: "API_KEY", kind: "create" }),
      secrets: fakeCipher(),
      db: fakeDb(),
    });
    const res = await fetch(`${base}/secret?t=whatever`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'none'");
    const body = await res.text();
    expect(body).toContain('name="brokered"');
    expect(body).toContain(WARNING);
    expect(body).toContain("fetch(url, { secrets:");
    expect(body).toContain("secret_brokered");
    expect(body).toContain('name="value"');
    expect(body).not.toMatch(/<script/i);
    expect(body).toContain("#brokered:checked ~ .broker-fields");
  });

  it("GET create page with a payload broker pre-checks the box and pre-fills the hosts", async () => {
    const base = await startTestServer({
      verify: async () => ({ ownerId: "p1", secretName: "API_KEY", kind: "create", broker: BROKER }),
      secrets: fakeCipher(),
      db: fakeDb(),
    });
    const body = await (await fetch(`${base}/secret?t=whatever`)).text();
    expect(body).toMatch(/<input type="checkbox" id="brokered" name="brokered" value="1" checked>/);
    expect(body).toMatch(/<textarea name="hosts"[^>]*>api\.github\.com<\/textarea>/);
  });

  it("brokerFieldset escapes pre-filled values", () => {
    const html = brokerFieldset({
      hosts: ["a.example.com"],
      placement: { kind: "header", name: "X-Key", format: '"><b>{value}' },
    });
    expect(html).not.toContain("<b>");
    expect(html).toContain("&quot;&gt;&lt;b&gt;{value}");
  });

  it("brokerFieldset groups each placement's fields so CSS shows only the selected one", () => {
    const html = brokerFieldset();
    const group = (kind: string) =>
      html.match(new RegExp(`<div class="placement placement-${kind}">([\\s\\S]*?)</div>`))?.[1];
    expect(group("header")).toContain('name="headerName"');
    expect(group("header")).toContain('name="headerFormat"');
    expect(group("query")).toContain('name="queryName"');
    expect(group("body")).toContain('name="bodyField"');
    expect(group("aws-sigv4")).toContain('name="awsRegion"');
    expect(group("aws-sigv4")).toContain('name="awsService"');
    expect(group("aws-sigv4")).toContain("secretAccessKey");
  });

  describe("brokerConfigFromForm", () => {
    const form = (fields: Record<string, string>) => new URLSearchParams(fields);

    it("returns null when the box is unchecked", () => {
      expect(brokerConfigFromForm(form({ hosts: "api.github.com", placement: "header" }))).toBeNull();
    });

    it("builds a header placement", () => {
      expect(
        brokerConfigFromForm(
          form({
            brokered: "1",
            hosts: "api.github.com",
            placement: "header",
            headerName: "Authorization",
            headerFormat: "Bearer {value}",
          }),
        ),
      ).toEqual(BROKER);
    });

    it("splits path prefixes one per line", () => {
      const config = brokerConfigFromForm(
        form({
          brokered: "1",
          hosts: "api.github.com\r\n",
          pathPrefixes: "/repos/\n/user",
          placement: "header",
          headerName: "Authorization",
          headerFormat: "Bearer {value}",
        }),
      );
      expect(config?.pathPrefixes).toEqual(["/repos/", "/user"]);
    });

    it("builds an aws-sigv4 placement", () => {
      const config = brokerConfigFromForm(
        form({
          brokered: "1",
          hosts: "s3.us-east-1.amazonaws.com",
          placement: "aws-sigv4",
          awsRegion: "us-east-1",
          awsService: "s3",
        }),
      );
      expect(config?.placement).toEqual({ kind: "aws-sigv4", region: "us-east-1", service: "s3" });
    });

    it("rejects an empty host list", () => {
      expect(() =>
        brokerConfigFromForm(form({ brokered: "1", hosts: "  \n", placement: "query", queryName: "api_key" })),
      ).toThrow(/secret_broker_config_invalid/);
    });
  });

  it("POST create with the box checked and an invalid config shows the error and saves nothing", async () => {
    const db = fakeDb();
    const base = await startTestServer({
      verify: async () => ({ ownerId: "p1", secretName: "FORM_BAD_BROKER", kind: "create" }),
      secrets: fakeCipher(),
      db,
    });
    const res = await fetch(`${base}/secret?t=whatever`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ value: "sk-live-abc123", brokered: "1", hosts: "", placement: "header" }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/secret_broker_config_invalid/);
    const { getSecretElicitationOutcome } = await import("./secret-elicitation.js");
    expect(await getSecretElicitationOutcome("p1", "FORM_BAD_BROKER", db)).toBeUndefined();
  });

  it("GET unbroker page shows the name, the current config, the warning, and a typed-name confirmation", async () => {
    const base = await startTestServer({
      verify: async () => ({ ownerId: "p1", secretName: "GH<x>", kind: "unbroker", brokerHash: "h" }),
      secrets: fakeCipher(),
      db: fakeDb([
        { name: "GH<x>", ownerId: "p1", broker: { ...BROKER, hosts: ["api.github.com"], pathPrefixes: ["/<i>"] } },
      ]),
    });
    const res = await fetch(`${base}/secret?t=whatever`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("script-src 'none'");
    const body = await res.text();
    expect(body).toContain("Remove brokering");
    expect(body).toContain("GH&lt;x&gt;");
    expect(body).not.toContain("GH<x>");
    expect(body).toContain("api.github.com");
    expect(body).toContain("/&lt;i&gt;");
    expect(body).not.toContain("<i>");
    expect(body).toContain(WARNING);
    expect(body).toContain('name="confirm"');
    expect(body).not.toContain('name="value"');
    expect(body).not.toContain('name="brokered"');
    expect(body).not.toMatch(/<script/i);
  });

  it("POST unbroker with the wrong name is refused and records nothing", async () => {
    const db = fakeDb([{ name: "GH", ownerId: "p1", broker: BROKER }]);
    const base = await startTestServer({
      verify: async () => ({ ownerId: "p1", secretName: "GH", kind: "unbroker", brokerHash: "h" }),
      secrets: fakeCipher(),
      db,
    });
    const res = await fetch(`${base}/secret?t=whatever`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ confirm: "gh" }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Type the secret&#39;s name to confirm.");
    const { getSecretElicitationOutcome } = await import("./secret-elicitation.js");
    expect(await getSecretElicitationOutcome("p1", "GH", db, "unbroker")).toBeUndefined();
  });

  it("POST to an unbroker link with a value never creates or rotates the secret", async () => {
    const db = fakeDb([{ name: "GH", ownerId: "p1", broker: BROKER }]);
    const base = await startTestServer({
      verify: async () => ({ ownerId: "p1", secretName: "GH", kind: "unbroker", brokerHash: "h" }),
      secrets: fakeCipher(),
      db,
    });
    const res = await fetch(`${base}/secret?t=whatever`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ value: "attacker-value" }),
    });
    expect(res.status).toBe(400);
    const { getSecretElicitationOutcome } = await import("./secret-elicitation.js");
    expect(await getSecretElicitationOutcome("p1", "GH", db)).toBeUndefined();
  });

  it("POST with a body over the 32 KiB cap gets a 413 page instead of crashing", async () => {
    const db = fakeDb();
    const base = await startTestServer({
      verify: async () => ({ ownerId: "p1", secretName: "FORM_TOO_BIG", kind: "create" }),
      secrets: fakeCipher(),
      db,
    });
    const res = await fetch(`${base}/secret?t=whatever`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ value: "x".repeat(40 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect(await res.text()).toContain("Value too large");
    const { getSecretElicitationOutcome } = await import("./secret-elicitation.js");
    expect(await getSecretElicitationOutcome("p1", "FORM_TOO_BIG", db)).toBeUndefined();
    // The server still answers afterwards.
    expect((await fetch(`${base}/secret?t=whatever`)).status).toBe(200);
  });

  it("an oversize POST to an unbroker link also gets a 413", async () => {
    const base = await startTestServer({
      verify: async () => ({ ownerId: "p1", secretName: "GH", kind: "unbroker", brokerHash: "h" }),
      secrets: fakeCipher(),
      db: fakeDb([{ name: "GH", ownerId: "p1", broker: BROKER }]),
    });
    const res = await fetch(`${base}/secret?t=whatever`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ confirm: "x".repeat(40 * 1024) }),
    });
    expect(res.status).toBe(413);
  });
});
