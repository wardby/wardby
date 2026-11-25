/** GET /admin/api/documents against real PostgreSQL. Skipped without DATABASE_URL. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../core/db.js";
import { createDocument } from "../core/documents/service.js";
import { attachSecret, createSecret } from "../core/secrets.js";
import { McpError, unauthorized } from "../mcp/errors.js";
import type { McpRequestContext } from "../mcp/context.js";
import { DocumentListSchema } from "./api-schema.js";
import type { ViewerEventBus } from "./event-bus.js";
import { createViewerApi, type ViewerApi } from "./http.js";

const SECRET = "fake-doc-list-secret-9f3a";
const coffee = (p: string) =>
  readFileSync(new URL(`../core/documents/boards/fixtures/coffee/${p}`, import.meta.url), "utf8");
const KEYS = [
  "agent",
  "id",
  "kind",
  "latestVersion",
  "mine",
  "pagePath",
  "path",
  "repository",
  "reviewState",
  "title",
  "updatedAt",
];

describe.skipIf(!process.env.DATABASE_URL)("viewer documents route (PostgreSQL)", () => {
  const db = createPrismaClient();
  const cipher = { keyId: () => "test", encrypt: async (s: string) => s, decrypt: async (s: string) => s };
  const s = randomUUID();
  let owner: Principal;
  let grantee: Principal;
  let stranger: Principal;
  const agentA = `vdoc-agent-a-${s}`;
  const agentB = `vdoc-agent-b-${s}`;
  const ids: Record<string, string> = {};
  let server: Server;
  let viewer: ViewerApi;
  let base = "";

  const bus: ViewerEventBus = {
    subscribe: () => () => {},
    onState: () => () => {},
    connected: () => true,
    close: async () => {},
  };

  beforeAll(async () => {
    owner = await db.principal.create({ data: { subject: `vdoc-owner-${s}` } });
    grantee = await db.principal.create({ data: { subject: `vdoc-grantee-${s}` } });
    stranger = await db.principal.create({ data: { subject: `vdoc-stranger-${s}` } });
    for (const id of [agentA, agentB]) {
      await db.agent.create({
        data: { id, name: `name-${id}`, systemPrompt: "t", model: "t", budgetUsd: 1, ownerId: owner.id },
      });
    }
    await createSecret(`VDOC_KEY_${s.slice(0, 8)}`, SECRET, owner.id, cipher, db);
    await attachSecret(agentA, `VDOC_KEY_${s.slice(0, 8)}`, owner.id, db);
    const mk = async (name: string, ownerId: string, extra: object = {}) => {
      ids[name] = (await createDocument(db, cipher, { ownerId, title: name, markdown: "body", ...extra })).id;
    };
    await mk("plain", owner.id);
    await mk("linked-a", owner.id, { agentId: agentA, repository: "acme/one", path: "docs/a.md" });
    await mk("linked-b", owner.id, { agentId: agentB, repository: "acme/two", path: "docs/b.md" });
    await mk("granted", stranger.id);
    await mk("strangers", stranger.id);
    await mk("secret-title", owner.id, {
      agentId: agentA,
      title: `leak ${SECRET} here`,
      markdown: `content ${SECRET}`,
    });
    await createDocument(db, cipher, {
      kind: "design",
      ownerId: owner.id,
      title: "a design",
      files: {
        "manifest.json": coffee("manifest.json"),
        "brand.md": coffee("brand.md"),
        ...Object.fromEntries(
          ["home", "menu", "about", "visit"].map((n) => [`boards/${n}.html`, coffee(`boards/${n}.html`)]),
        ),
      },
    }).then((d) => (ids.design = d.id));
    await db.resourceGrant.create({
      data: {
        resourceType: "document",
        resourceId: ids.granted,
        granteeKind: "principal",
        granteePrincipalId: owner.id,
        granteeKey: `principal:${owner.id}`,
        level: "read",
      },
    });
    viewer = createViewerApi({
      db,
      bus,
      authenticate: async (authorization) => {
        if (!authorization) throw unauthorized("no token", "https://host/.well-known/oauth-protected-resource");
        const scopes = authorization.includes("noscope") ? [] : ["admin:view"];
        const principal = authorization.includes("grantee") ? grantee : owner;
        return {
          principal,
          canonicalUri: "https://host/mcp",
          scopes: new Set(scopes),
          roles: ["admin"],
          providers: { secrets: cipher },
        } as unknown as McpRequestContext;
      },
      canonicalUri: "https://host/mcp",
      infra: { launcher: "local", kubernetes: null, native: null },
    });
    server = createServer((req, res) => {
      viewer
        .handle(req, res, new URL(req.url ?? "/", "http://host"))
        .then((handled) => {
          if (!handled) res.writeHead(404).end();
        })
        .catch((err: unknown) => {
          const status = err instanceof McpError ? err.httpStatus : 500;
          res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: "x" }));
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    viewer.closeStreams();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.document.deleteMany({ where: { ownerId: { in: [owner.id, grantee.id, stranger.id] } } });
    await db.$disconnect();
  });

  const get = (qs = "", token = "owner", init: RequestInit = {}) =>
    fetch(`${base}/admin/api/documents${qs}`, { ...init, headers: { authorization: `Bearer ${token}` } });
  const list = async (qs = "") => {
    const res = await get(qs);
    expect(res.status).toBe(200);
    return DocumentListSchema.parse(await res.json());
  };

  it("lists the caller's own and granted documents, not a stranger's", async () => {
    const got = (await list()).documents;
    const have = got.map((d) => d.id);
    expect(have).toEqual(
      expect.arrayContaining([ids.plain, ids["linked-a"], ids["linked-b"], ids.granted, ids.design]),
    );
    expect(have).not.toContain(ids.strangers);
    expect(got.find((d) => d.id === ids.granted)?.mine).toBe(false);
    expect(got.find((d) => d.id === ids.plain)).toMatchObject({
      mine: true,
      kind: "document",
      agent: null,
      repository: null,
      latestVersion: 1,
      reviewState: "draft",
      pagePath: `/d/${ids.plain}`,
    });
    await db.document.update({ where: { id: ids.granted }, data: { reviewState: "approved" } });
    const after = (await list()).documents;
    expect(after.find((d) => d.id === ids.granted)?.reviewState).toBe("approved");
    expect(got.find((d) => d.id === ids.design)?.kind).toBe("design");
    expect(got.find((d) => d.id === ids["linked-a"])).toMatchObject({
      agent: { id: agentA, name: `name-${agentA}` },
      repository: "acme/one",
      path: "docs/a.md",
    });
    const theirs = (await (await get("", "grantee")).json()) as { documents: { id: string }[] };
    expect(theirs.documents.map((d) => d.id)).not.toContain(ids.plain);
  });

  it("filters by agent and repository", async () => {
    const byAgent = (await list(`?agent=${agentB}`)).documents.map((d) => d.id);
    expect(byAgent).toEqual([ids["linked-b"]]);
    const byRepo = (await list(`?repository=${encodeURIComponent("acme/one")}`)).documents.map((d) => d.id);
    expect(byRepo).toContain(ids["linked-a"]);
    expect(byRepo).not.toContain(ids["linked-b"]);
    expect((await list(`?agent=${agentB}&repository=acme%2Fone`)).documents).toEqual([]);
  });

  it("bounds the limit and reports truncation", async () => {
    const one = await list("?limit=1");
    expect(one.documents).toHaveLength(1);
    expect(one.truncated).toBe(true);
    for (const bad of ["0", "501", "-1", "abc", "1.5"]) {
      const res = await get(`?limit=${bad}`);
      expect(res.status, bad).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid_limit" });
    }
    expect((await get("?limit=500")).status).toBe(200);
  });

  it("answers 405 to a POST and needs the admin:view scope", async () => {
    const post = await get("", "owner", { method: "POST" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
    expect((await get("", "noscope")).status).toBe(403);
    expect((await fetch(`${base}/admin/api/documents`)).status).toBe(401);
  });

  it("sends only metadata: no content, comments or secret values", async () => {
    const res = await get();
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("content ");
    const { documents } = JSON.parse(text) as { documents: Record<string, unknown>[] };
    expect(documents.length).toBeGreaterThan(0);
    for (const d of documents) expect(Object.keys(d).sort()).toEqual(KEYS);
    const redacted = documents.find((d) => d.id === ids["secret-title"]);
    expect(redacted?.title).toMatch(/^leak .* here$/);
  });
});
