import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import type { Principal } from "#prisma";
import { createPrismaClient } from "../../core/db.js";
import { REQUIRED_OPERATIONS } from "../../providers/host-tools/operations.js";
import type { SecretCipher } from "../../providers/secrets/types.js";
import type { McpProviders, McpRequestContext } from "../context.js";
import { buildMcpServer } from "../server.js";
import { registerHostProviderTools } from "./host-providers.js";
import { registerSecretsTools } from "./secrets.js";

const db = createPrismaClient();
const principalIds: string[] = [];
const providerNames: string[] = [];
const secretIds: string[] = [];
const agentIds: string[] = [];
const CANONICAL = "https://wardby.example/mcp";

const TOKEN = "fake-repo-token-0123456789";
const WEBHOOK = "fake-webhook-secret-0123456789";
const BROKER = {
  hosts: ["api.example.test", "git.example.test"],
  placement: { kind: "header", name: "Authorization", format: "Bearer {value}" },
};

const cipher: SecretCipher = {
  keyId: () => "k",
  encrypt: async (v: string) => `enc:${v}`,
  decrypt: async (c: string) => c.slice(4),
};

async function principal(): Promise<Principal> {
  const p = await db.principal.create({ data: { subject: `host-provider-${randomUUID()}` } });
  principalIds.push(p.id);
  return p;
}

async function secret(
  p: Principal,
  name: string,
  value: string,
  broker: object | null = null,
): Promise<{ id: string; name: string }> {
  const row = await db.secret.create({
    data: { name, ciphertext: `enc:${value}`, keyId: "k", ownerId: p.id, ...(broker ? { broker } : {}) },
  });
  secretIds.push(row.id);
  return row;
}

async function seed(p: Principal) {
  const credential = await secret(p, "repo-token", TOKEN, BROKER);
  const webhook = await secret(p, "webhook", WEBHOOK);
  const tools = Object.fromEntries(
    await Promise.all(
      REQUIRED_OPERATIONS.map(async (operation) => {
        const tool = await db.tool.create({
          data: {
            name: `tool-${operation}`,
            description: "d",
            paramsZod: "z.object({}).passthrough()",
            jsonSchema: {},
            code: `return { op: "${operation}" };`,
            ownerId: p.id,
          },
        });
        return [operation, tool.name];
      }),
    ),
  );
  return { credential, webhook, tools };
}

const args = (name: string, tools: Record<string, string>) => ({
  provider: name,
  gitHost: "git.example.test",
  apiHosts: ["api.example.test"],
  gitUsername: "x-token-auth",
  pullRequestUrlTemplate: "https://git.example.test/{repository}/pull/{number}",
  repositoryApiPath: "/2.0/repositories/{repository}",
  webhook: { header: "X-Sig", algorithm: "sha256", deliveryHeader: "X-Id", eventHeader: "X-Event", secret: "webhook" },
  credentials: [{ repositories: "acme/*", secret: "repo-token" }],
  trustedAccounts: ["acct-1"],
  tools,
});

const newName = () => {
  const name = `t${randomUUID().slice(0, 8)}`;
  providerNames.push(name);
  return name;
};

async function connect(
  p: Principal,
  options: { scopes?: string[]; roles?: string[] } = {},
): Promise<{ call: (name: string, a?: Record<string, unknown>) => Promise<{ isError: boolean; text: string }> }> {
  const providers = { secrets: cipher } as unknown as McpProviders;
  const mcp = buildMcpServer({ providers, db, config: { canonicalUri: CANONICAL } });
  const ctx: McpRequestContext = {
    principal: p,
    scopes: new Set(options.scopes ?? ["hosts:admin", "tools:write", "secrets:write"]),
    roles: options.roles ?? ["host-manager"],
    canonicalUri: CANONICAL,
    providers,
    db,
    clientSupportsTasks: false,
    mcpReq: { requestState: () => undefined },
  };
  mcp.setFixedContext(ctx);
  registerHostProviderTools(mcp);
  registerSecretsTools(mcp, {
    buildElicitationUrl: async () => "https://wardby.example/secret",
    protocolElicitation: false,
  });
  const server = (await mcp.factory({ era: "modern" })) as import("@modelcontextprotocol/server").McpServer;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" }, { versionNegotiation: { mode: "auto" } });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    call: async (name, a = {}) => {
      const result = (await client.callTool({ name, arguments: a })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      return { isError: Boolean(result.isError), text: result.content[0].text };
    },
  };
}

async function agent(p: Principal) {
  const row = await db.agent.create({
    data: { name: `hp-agent-${randomUUID()}`, systemPrompt: "x", model: "gpt-5.6-luna", budgetUsd: 1, ownerId: p.id },
  });
  agentIds.push(row.id);
  return row;
}

afterAll(async () => {
  await db.agentSecret.deleteMany({ where: { agentId: { in: agentIds } } });
  await db.agent.deleteMany({ where: { id: { in: agentIds } } });
  await db.hostProvider.deleteMany({ where: { name: { in: providerNames } } });
  await db.secret.deleteMany({ where: { id: { in: secretIds } } });
  await db.tool.deleteMany({ where: { ownerId: { in: principalIds } } });
  await db.principal.deleteMany({ where: { id: { in: principalIds } } });
  await db.$disconnect();
});

describe("host provider tools", () => {
  it("needs hosts:admin, and a role that grants it", async () => {
    const p = await principal();
    const { tools } = await seed(p);
    const name = newName();

    const noRole = await (await connect(p, { roles: [] })).call("register_host_provider", args(name, tools));
    expect(noRole.isError).toBe(true);
    expect(noRole.text).toContain("host-manager");

    const noScope = await (
      await connect(p, { scopes: ["tools:write"] })
    ).call("register_host_provider", args(name, tools));
    expect(noScope.isError).toBe(true);
    expect(await db.hostProvider.findUnique({ where: { name } })).toBeNull();
  });

  it("registers a provider, with secret names and no value", async () => {
    const p = await principal();
    const { tools } = await seed(p);
    const name = newName();
    const { call } = await connect(p);

    const result = await call("register_host_provider", args(name, tools));
    expect(result.isError).toBe(false);
    expect(result.text).not.toContain(TOKEN);
    expect(result.text).not.toContain(WEBHOOK);
    const view = JSON.parse(result.text);
    expect(view).toMatchObject({
      provider: name,
      mode: "allowlist",
      restartRequired: true,
      webhookSecret: "webhook",
      permissionSecret: null,
      credentials: [{ repositories: "acme/*", secret: "repo-token", kind: "static" }],
      trustedAccounts: ["acct-1"],
    });
    expect(view.operations).toHaveLength(REQUIRED_OPERATIONS.length);
    for (const op of view.operations) expect(op.status).toBe("approved");

    const rows = await db.hostProviderOperation.findMany({ where: { provider: name }, include: { tool: true } });
    for (const row of rows) expect(row.code).toBe(row.tool!.code);
  });

  it("runs the copy, not the tool: a tool change waits for approval", async () => {
    const p = await principal();
    const { tools } = await seed(p);
    const name = newName();
    const { call } = await connect(p);
    const first = JSON.parse((await call("register_host_provider", args(name, tools))).text);
    const operation = REQUIRED_OPERATIONS[0];
    const before = first.operations.find((o: { operation: string }) => o.operation === operation);

    await db.tool.update({
      where: { ownerId_name: { ownerId: p.id, name: tools[operation] } },
      data: { code: "return { changed: true };" },
    });
    const row = await db.hostProviderOperation.findUniqueOrThrow({
      where: { provider_operation: { provider: name, operation } },
    });
    expect(row.code).toBe(`return { op: "${operation}" };`);

    const got = JSON.parse((await call("get_host_provider", { provider: name })).text);
    const changed = got.operations.find((o: { operation: string }) => o.operation === operation);
    expect(changed.status).toBe("changed");
    expect(changed.currentSha256).not.toBe(changed.approvedSha256);
    expect(changed.approvedSha256).toBe(before.approvedSha256);
    expect(changed.approvedCode).toBeUndefined();

    const withCode = JSON.parse((await call("get_host_provider", { provider: name, includeCode: true })).text);
    const coded = withCode.operations.find((o: { operation: string }) => o.operation === operation);
    expect(coded.approvedCode).toBe(`return { op: "${operation}" };`);
    expect(coded.currentCode).toBe("return { changed: true };");

    const approved = JSON.parse(
      (await call("approve_host_provider_tools", { provider: name, tools: [operation] })).text,
    );
    const after = approved.operations.find((o: { operation: string }) => o.operation === operation);
    expect(after.status).toBe("approved");
    expect(after.approvedById).toBe(p.id);
    const updated = await db.hostProviderOperation.findUniqueOrThrow({
      where: { provider_operation: { provider: name, operation } },
    });
    expect(updated.code).toBe("return { changed: true };");
  });

  it("keeps the snapshot when its tool is deleted, and won't approve it", async () => {
    const p = await principal();
    const { tools } = await seed(p);
    const name = newName();
    const { call } = await connect(p);
    await call("register_host_provider", args(name, tools));
    const operation = REQUIRED_OPERATIONS[0];
    await db.tool.delete({ where: { ownerId_name: { ownerId: p.id, name: tools[operation] } } });

    const got = JSON.parse((await call("get_host_provider", { provider: name })).text);
    const gone = got.operations.find((o: { operation: string }) => o.operation === operation);
    expect(gone.status).toBe("tool_deleted");
    expect(gone.toolName).toBeNull();
    const row = await db.hostProviderOperation.findUniqueOrThrow({
      where: { provider_operation: { provider: name, operation } },
    });
    expect(row.code).toBe(`return { op: "${operation}" };`);

    const approve = await call("approve_host_provider_tools", { provider: name, tools: [operation] });
    expect(approve.isError).toBe(true);
    expect(approve.text).toContain("host_provider_tool_deleted");
  });

  describe("refusals", () => {
    async function refused(p: Principal, name: string, input: Record<string, unknown>, code: string) {
      const { call } = await connect(p);
      const result = await call("register_host_provider", input);
      expect(result.isError).toBe(true);
      expect(result.text).toContain(code);
      expect(result.text).not.toContain(TOKEN);
      expect(result.text).not.toContain(WEBHOOK);
      expect(await db.hostProvider.findUnique({ where: { name } })).toBeNull();
    }

    it("a missing required operation", async () => {
      const p = await principal();
      const { tools } = await seed(p);
      const name = newName();
      const [, ...rest] = Object.entries(tools);
      await refused(
        p,
        name,
        args(name, Object.fromEntries(rest) as Record<string, string>),
        "host_provider_missing_operation",
      );
    });

    it("an unknown operation", async () => {
      const p = await principal();
      const { tools } = await seed(p);
      const name = newName();
      await refused(p, name, args(name, { ...tools, mergePullRequestNow: "x" }), "host_provider_operation_not_bound");
    });

    it("an inherited property name as an operation", async () => {
      const p = await principal();
      const { tools } = await seed(p);
      const name = newName();
      await refused(p, name, args(name, { ...tools, constructor: "x" }), "host_provider_operation_not_bound");
    });

    it("another owner's tool", async () => {
      const p = await principal();
      const other = await principal();
      const { tools } = await seed(p);
      const foreign = await db.tool.create({
        data: {
          name: "foreign-tool",
          description: "d",
          paramsZod: "z.object({}).passthrough()",
          jsonSchema: {},
          code: "return {};",
          ownerId: other.id,
        },
      });
      const name = newName();
      await refused(
        p,
        name,
        args(name, { ...tools, [REQUIRED_OPERATIONS[0]]: foreign.name }),
        "host_provider_tool_not_found",
      );
    });

    it("a credential that isn't brokered", async () => {
      const p = await principal();
      const { tools } = await seed(p);
      await secret(p, "plain-token", TOKEN);
      const name = newName();
      await refused(
        p,
        name,
        { ...args(name, tools), credentials: [{ repositories: "acme/*", secret: "plain-token" }] },
        "host_provider_secret_not_brokered",
      );
    });

    it("a credential whose broker hosts lack the git host", async () => {
      const p = await principal();
      const { tools } = await seed(p);
      await secret(p, "no-git", TOKEN, { ...BROKER, hosts: ["api.example.test"] });
      const name = newName();
      await refused(
        p,
        name,
        { ...args(name, tools), credentials: [{ repositories: "acme/*", secret: "no-git" }] },
        "host_provider_secret_hosts",
      );
    });

    it("a credential whose broker hosts lack an API host", async () => {
      const p = await principal();
      const { tools } = await seed(p);
      await secret(p, "no-api", TOKEN, { ...BROKER, hosts: ["git.example.test"] });
      const name = newName();
      await refused(
        p,
        name,
        { ...args(name, tools), credentials: [{ repositories: "acme/*", secret: "no-api" }] },
        "host_provider_secret_hosts",
      );
    });

    it("an aws-sigv4 placement", async () => {
      const p = await principal();
      const { tools } = await seed(p);
      await secret(p, "sigv4", TOKEN, {
        hosts: BROKER.hosts,
        placement: { kind: "aws-sigv4", region: "us-east-1", service: "s3" },
      });
      const name = newName();
      await refused(
        p,
        name,
        { ...args(name, tools), credentials: [{ repositories: "acme/*", secret: "sigv4" }] },
        "host_provider_secret_placement",
      );
    });

    it("a git username equal to the credential's value", async () => {
      const p = await principal();
      const { tools } = await seed(p);
      const name = newName();
      await refused(p, name, { ...args(name, tools), gitUsername: TOKEN }, "host_provider_username_is_secret");
    });

    it("a webhook secret attached to an agent", async () => {
      const p = await principal();
      const { tools, webhook } = await seed(p);
      const a = await agent(p);
      await db.agentSecret.create({ data: { agentId: a.id, secretId: webhook.id, boundName: "webhook" } });
      const name = newName();
      await refused(p, name, args(name, tools), "host_provider_webhook_secret_shared");
    });

    it("a webhook secret also used as a credential", async () => {
      const p = await principal();
      const { tools } = await seed(p);
      await secret(p, "both", WEBHOOK, BROKER);
      const name = newName();
      await refused(
        p,
        name,
        {
          ...args(name, tools),
          webhook: { ...args(name, tools).webhook, secret: "both" },
          credentials: [{ repositories: "acme/*", secret: "both" }],
        },
        "host_provider_webhook_secret_shared",
      );
    });

    it("a webhook secret of 15 characters", async () => {
      const p = await principal();
      const { tools } = await seed(p);
      await secret(p, "short-hook", "fake-15-chars-0");
      const name = newName();
      await refused(
        p,
        name,
        { ...args(name, tools), webhook: { ...args(name, tools).webhook, secret: "short-hook" } },
        "host_provider_webhook_secret_short",
      );
    });
  });

  it("registers permission mode, and needs getRepositoryPermission for it", async () => {
    const p = await principal();
    const { tools } = await seed(p);
    await secret(p, "perm-token", TOKEN, { ...BROKER, hosts: ["api.example.test"] });
    const permission = {
      permissionCredential: "perm-token",
      permissionApiPath: "/2.0/workspaces/{workspace}/permissions/repositories/{repo}",
    };
    const { call } = await connect(p);

    const unbound = newName();
    const refused = await call("register_host_provider", { ...args(unbound, tools), ...permission });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("host_provider_missing_operation");
    expect(refused.text).not.toContain(TOKEN);
    expect(await db.hostProvider.findUnique({ where: { name: unbound } })).toBeNull();

    const name = newName();
    const ok = await call("register_host_provider", {
      ...args(name, { ...tools, getRepositoryPermission: tools[REQUIRED_OPERATIONS[0]] }),
      ...permission,
    });
    expect(ok.isError).toBe(false);
    expect(ok.text).not.toContain(TOKEN);
    expect(JSON.parse(ok.text)).toMatchObject({ mode: "permission", permissionSecret: "perm-token" });
  });

  it("replaces credentials and trusted accounts when registered again", async () => {
    const p = await principal();
    const { tools } = await seed(p);
    await secret(p, "second-token", TOKEN, BROKER);
    const name = newName();
    const { call } = await connect(p);
    await call("register_host_provider", args(name, tools));

    const again = await call("register_host_provider", {
      ...args(name, tools),
      credentials: [{ repositories: "other/*", secret: "second-token" }],
      trustedAccounts: ["acct-2", "acct-3"],
    });
    expect(again.isError).toBe(false);
    const view = JSON.parse(again.text);
    expect(view.credentials).toEqual([{ repositories: "other/*", secret: "second-token", kind: "static" }]);
    expect(view.trustedAccounts).toEqual(["acct-2", "acct-3"]);
    expect(await db.hostProviderCredential.count({ where: { provider: name } })).toBe(1);
  });

  it("deletes a provider, unless an agent links to it", async () => {
    const p = await principal();
    const { tools } = await seed(p);
    const { call } = await connect(p);

    const free = newName();
    await call("register_host_provider", args(free, tools));
    expect((await call("delete_host_provider", { provider: free })).isError).toBe(false);
    expect(await db.hostProvider.findUnique({ where: { name: free } })).toBeNull();
    expect(await db.hostProviderOperation.count({ where: { provider: free } })).toBe(0);
    expect(await db.hostProviderCredential.count({ where: { provider: free } })).toBe(0);

    const used = newName();
    await call("register_host_provider", args(used, tools));
    const a = await agent(p);
    await db.agentRepository.create({
      data: {
        agentId: a.id,
        provider: used,
        repository: "acme/web",
        access: "read",
        authorizedVia: "admin",
        authorizedById: p.id,
      },
    });
    const refused = await call("delete_host_provider", { provider: used });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("host_provider_in_use");
    expect(await db.hostProvider.findUnique({ where: { name: used } })).not.toBeNull();
  });

  it("delete_secret refuses a secret a provider uses", async () => {
    const p = await principal();
    const { tools, credential, webhook } = await seed(p);
    const name = newName();
    const { call } = await connect(p);
    await call("register_host_provider", args(name, tools));

    for (const used of [credential, webhook]) {
      const result = await call("delete_secret", { id: used.id });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("host provider");
      expect(await db.secret.findUnique({ where: { id: used.id } })).not.toBeNull();
    }
  });

  it("attach_secret refuses a provider's webhook secret", async () => {
    const p = await principal();
    const { tools } = await seed(p);
    const name = newName();
    const { call } = await connect(p, { scopes: ["hosts:admin", "tools:write", "secrets:write", "agents:write"] });
    await call("register_host_provider", args(name, tools));
    const a = await agent(p);

    const result = await call("attach_secret", { agentId: a.id, name: "webhook" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("webhook secret");
    expect(result.text).not.toContain(WEBHOOK);
    expect(await db.agentSecret.count({ where: { agentId: a.id } })).toBe(0);
  });
});
