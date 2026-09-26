import { describe, it, expect } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../server.js";
import { registerRepositoryTools } from "./repositories.js";
import type { McpRequestContext } from "../context.js";

const CANONICAL_URI = "https://host/mcp";

interface FakeAgentRow {
  id: string;
  name: string;
  ownerId: string | null;
  kind: "native" | "coding";
}

interface FakeRepositoryRow {
  id: string;
  agentId: string;
  provider: string;
  repository: string;
  access: string;
  triggers: string[];
  checkName: string | null;
  createdAt: Date;
}

function fakeDb(agents: FakeAgentRow[], repositories: FakeRepositoryRow[] = []) {
  const agentRows = new Map(agents.map((a) => [a.id, a]));
  const rows: FakeRepositoryRow[] = [...repositories];
  let nextId = rows.length + 1;

  const db = {
    agent: {
      findUnique: async ({ where }: { where: { id: string } }) => agentRows.get(where.id) ?? null,
    },
    agentRepository: {
      findMany: async (opts?: {
        where?: { provider?: string; repository?: string; agentId?: string; NOT?: { agentId?: string } };
      }) => {
        let result = rows;
        const where = opts?.where;
        if (where?.provider !== undefined) result = result.filter((r) => r.provider === where.provider);
        if (where?.repository !== undefined) result = result.filter((r) => r.repository === where.repository);
        if (where?.agentId !== undefined) result = result.filter((r) => r.agentId === where.agentId);
        if (where?.NOT?.agentId !== undefined) result = result.filter((r) => r.agentId !== where.NOT!.agentId);
        return result.map((r) => ({ ...r }));
      },
      upsert: async ({
        where,
        create,
        update,
      }: {
        where: { agentId_provider_repository: { agentId: string; provider: string; repository: string } };
        create: Omit<FakeRepositoryRow, "id" | "createdAt">;
        update: { access: string; triggers: string[]; checkName: string | null };
      }) => {
        const { agentId, provider, repository } = where.agentId_provider_repository;
        const existing = rows.find(
          (r) => r.agentId === agentId && r.provider === provider && r.repository === repository,
        );
        if (existing) {
          existing.access = update.access;
          existing.triggers = update.triggers;
          existing.checkName = update.checkName;
          return { ...existing };
        }
        const row: FakeRepositoryRow = { id: `repo${nextId++}`, createdAt: new Date(), ...create };
        rows.push(row);
        return { ...row };
      },
      deleteMany: async ({ where }: { where: { agentId: string; provider: string; repository: string } }) => {
        const before = rows.length;
        const kept = rows.filter(
          (r) => !(r.agentId === where.agentId && r.provider === where.provider && r.repository === where.repository),
        );
        rows.length = 0;
        rows.push(...kept);
        return { count: before - kept.length };
      },
    },
  };

  return {
    ...db,
    $transaction: async (fn: (tx: typeof db) => Promise<unknown>) => fn(db),
  } as unknown as import("#prisma").PrismaClient;
}

function fakeCtx(db: ReturnType<typeof fakeDb>, principalId: string, scopes: string[]): McpRequestContext {
  return {
    principal: { id: principalId, subject: principalId, createdAt: new Date() },
    scopes: new Set(scopes),
    canonicalUri: CANONICAL_URI,
    providers: {} as unknown as import("../../providers/index.js").ProviderRegistry,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  };
}

async function connectClient(mcp: ReturnType<typeof buildMcpServer>) {
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function parseText(result: { content: { text: string }[] }): unknown {
  return JSON.parse(result.content[0].text);
}

function errorText(result: { content: { text: string }[] }): string {
  return result.content[0].text;
}

function setup(agents: FakeAgentRow[], principalId: string, repositories: FakeRepositoryRow[] = []) {
  const db = fakeDb(agents, repositories);
  const mcp = buildMcpServer({ providers: {} as never, db, config: { canonicalUri: CANONICAL_URI } });
  mcp.setFixedContext(fakeCtx(db, principalId, ["agents:read", "agents:write"]));
  registerRepositoryTools(mcp);
  return { db, mcp };
}

describe("repository tools", () => {
  it("describes link_repository as a full replace of the link", async () => {
    const { mcp } = setup([], "p1");
    const client = await connectClient(mcp);
    const { tools } = await client.listTools();
    const link = tools.find((t) => t.name === "link_repository")!;
    expect(link.description).toMatch(/replaces/i);
    expect(link.description).toContain("full desired state");
  });

  it("links a native agent owned by the caller, normalizing the repository", async () => {
    const { mcp } = setup([{ id: "a1", name: "reviewer", ownerId: "p1", kind: "native" }], "p1");
    const client = await connectClient(mcp);

    const link = await client.callTool({
      name: "link_repository",
      arguments: {
        agentId: "a1",
        repository: "ChFields/Knock-Knock-Jokes",
        access: "write",
        triggers: ["pull_request"],
        checkName: "wardby review",
      },
    });
    expect(link.isError).toBeFalsy();
    const parsed = parseText(link as never) as { linked: boolean; link: Record<string, unknown> };
    expect(parsed.linked).toBe(true);
    expect(parsed.link).toMatchObject({
      agentId: "a1",
      provider: "github",
      repository: "chfields/knock-knock-jokes",
      access: "write",
      triggers: ["pull_request"],
      checkName: "wardby review",
    });

    const listed = await client.callTool({ name: "list_repositories", arguments: { agentId: "a1" } });
    const { repositories } = parseText(listed as never) as { repositories: Record<string, unknown>[] };
    expect(repositories).toHaveLength(1);
    expect(repositories[0]).toMatchObject({
      provider: "github",
      repository: "chfields/knock-knock-jokes",
      triggers: ["pull_request"],
      checkName: "wardby review",
    });
    await client.close();
  });

  it("rejects coding agents, bad repositories, bad access, and unknown triggers", async () => {
    const { mcp } = setup(
      [
        { id: "a1", name: "reviewer", ownerId: "p1", kind: "native" },
        { id: "c1", name: "coder", ownerId: "p1", kind: "coding" },
      ],
      "p1",
    );
    const client = await connectClient(mcp);

    const codingResult = await client.callTool({
      name: "link_repository",
      arguments: { agentId: "c1", repository: "openai/example", access: "write" },
    });
    expect(codingResult.isError).toBeTruthy();
    expect(errorText(codingResult as never)).toContain("native agents only");

    const badRepoResult = await client.callTool({
      name: "link_repository",
      arguments: { agentId: "a1", repository: "https://evil.example/x/y", access: "write" },
    });
    expect(badRepoResult.isError).toBeTruthy();
    expect(errorText(badRepoResult as never)).toContain("invalid repository");

    const badAccessResult = await client.callTool({
      name: "link_repository",
      arguments: { agentId: "a1", repository: "openai/example", access: "admin" },
    });
    expect(badAccessResult.isError).toBeTruthy();

    const badTriggerResult = await client.callTool({
      name: "link_repository",
      arguments: { agentId: "a1", repository: "openai/example", access: "write", triggers: ["push"] },
    });
    expect(badTriggerResult.isError).toBeTruthy();
    await client.close();
  });

  it("requires write access and a checkName for event triggers", async () => {
    const { mcp } = setup([{ id: "a1", name: "reviewer", ownerId: "p1", kind: "native" }], "p1");
    const client = await connectClient(mcp);

    const readWithTrigger = await client.callTool({
      name: "link_repository",
      arguments: { agentId: "a1", repository: "openai/example", access: "read", triggers: ["mention"] },
    });
    expect(readWithTrigger.isError).toBeTruthy();
    expect(errorText(readWithTrigger as never)).toContain("Event triggers need write access.");

    const missingCheckName = await client.callTool({
      name: "link_repository",
      arguments: { agentId: "a1", repository: "openai/example", access: "write", triggers: ["pull_request"] },
    });
    expect(missingCheckName.isError).toBeTruthy();
    expect(errorText(missingCheckName as never)).toContain("checkName is required");
    await client.close();
  });

  it("allows one mention agent per repository and one agent per check name", async () => {
    const { mcp } = setup(
      [
        { id: "a1", name: "reviewer", ownerId: "p1", kind: "native" },
        { id: "a2", name: "mentioner", ownerId: "p1", kind: "native" },
      ],
      "p1",
    );
    const client = await connectClient(mcp);

    const seedMention = await client.callTool({
      name: "link_repository",
      arguments: { agentId: "a2", repository: "openai/example", access: "write", triggers: ["mention"] },
    });
    expect(seedMention.isError).toBeFalsy();

    const conflictMention = await client.callTool({
      name: "link_repository",
      arguments: { agentId: "a1", repository: "openai/example", access: "write", triggers: ["mention"] },
    });
    expect(conflictMention.isError).toBeTruthy();
    expect(errorText(conflictMention as never)).toContain("already handles @-mentions");

    const seedCheck = await client.callTool({
      name: "link_repository",
      arguments: {
        agentId: "a2",
        repository: "openai/other",
        access: "write",
        triggers: ["pull_request"],
        checkName: "wardby review",
      },
    });
    expect(seedCheck.isError).toBeFalsy();

    const conflictCheck = await client.callTool({
      name: "link_repository",
      arguments: {
        agentId: "a1",
        repository: "openai/other",
        access: "write",
        triggers: ["pull_request"],
        checkName: "wardby review",
      },
    });
    expect(conflictCheck.isError).toBeTruthy();
    expect(errorText(conflictCheck as never)).toContain("already uses check name");

    // Re-linking a1 itself (update) with a2's mention repo but no triggers is fine
    // and re-linking the check-name repo with a different agent's OWN existing
    // link is an update, not a conflict.
    const selfUpdate = await client.callTool({
      name: "link_repository",
      arguments: {
        agentId: "a2",
        repository: "openai/other",
        access: "write",
        triggers: ["pull_request"],
        checkName: "wardby review",
      },
    });
    expect(selfUpdate.isError).toBeFalsy();
    await client.close();
  });

  it("refuses to link an agent the caller does not own", async () => {
    const { mcp } = setup([{ id: "a1", name: "reviewer", ownerId: "someone-else", kind: "native" }], "p1");
    const client = await connectClient(mcp);

    const result = await client.callTool({
      name: "link_repository",
      arguments: { agentId: "a1", repository: "openai/example", access: "write" },
    });
    expect(result.isError).toBeTruthy();
    expect(errorText(result as never)).toContain("not owned by the caller");
    await client.close();
  });

  it("unlinks and lists", async () => {
    const { mcp } = setup([{ id: "a1", name: "reviewer", ownerId: "p1", kind: "native" }], "p1");
    const client = await connectClient(mcp);

    await client.callTool({
      name: "link_repository",
      arguments: { agentId: "a1", repository: "openai/example", access: "write" },
    });
    const unlinked = await client.callTool({
      name: "unlink_repository",
      arguments: { agentId: "a1", repository: "openai/example" },
    });
    expect(unlinked.isError).toBeFalsy();
    expect(parseText(unlinked as never)).toEqual({ unlinked: true });

    const listed = await client.callTool({ name: "list_repositories", arguments: { agentId: "a1" } });
    expect(parseText(listed as never)).toEqual({ repositories: [] });
    await client.close();
  });
});
