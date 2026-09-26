import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createPrismaClient } from "../../../core/db.js";
import { SelfHostedAuthProvider } from "../../../providers/auth/self-hosted.js";
import { IdentityService } from "./credentials.js";
import { authCommand } from "./cli.js";
import { startHttpServer, type HttpServerHandle } from "../../transport/streamable-http.js";
import { buildMcpServer } from "../../server.js";
import { registerAgentTools } from "../../tools/agents.js";
import { registerMemoryTools } from "../../tools/memory.js";
import type { McpProviders } from "../../context.js";

// Finding A1, roles design: scopes only delegate; a privileged operation
// needs the privileged scope on the token AND the admin role on the user,
// looked up live on every request.
describe.skipIf(!process.env.DATABASE_URL)("self-hosted user roles (database)", () => {
  const db = createPrismaClient();
  const hashKey = randomBytes(32).toString("hex");
  const identities = new IdentityService(db, hashKey);
  const subjects: string[] = [];
  const clients: string[] = [];
  const everything = "agents:read agents:write agents:admin packages:approve memory:write not-a-scope";
  let server: HttpServerHandle | undefined;
  let origin = "";
  let provider: SelfHostedAuthProvider;

  beforeAll(async () => {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as import("node:net").AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));
    origin = `http://127.0.0.1:${port}`;
    provider = new SelfHostedAuthProvider(
      { canonicalUri: origin + "/mcp", signingKey: "c3".repeat(32), credentialHashKey: hashKey },
      db,
    );
    const providers = {} as McpProviders;
    const mcp = buildMcpServer({ providers, db, config: { canonicalUri: origin + "/mcp" } });
    registerAgentTools(mcp);
    registerMemoryTools(mcp);
    server = await startHttpServer({
      mcp,
      config: { canonicalUri: origin + "/mcp", httpBind: { host: "127.0.0.1", port }, authProviderKind: "self-hosted" },
      auth: { authProvider: provider, db, providers },
      selfHosted: provider,
    });
  });
  afterAll(async () => {
    await server?.close();
    await db.oAuthClient.deleteMany({ where: { clientId: { in: clients } } });
    await db.authUser.deleteMany({ where: { principal: { subject: { in: subjects } } } });
    await db.principal.deleteMany({ where: { subject: { in: subjects } } });
    await db.$disconnect();
  });

  async function cli(...args: string[]): Promise<string> {
    const lines: string[] = [];
    await authCommand(args, db, hashKey, (s) => lines.push(s));
    return lines.join("\n");
  }

  async function newUser(...createFlags: string[]) {
    const subject = "role-" + randomUUID();
    subjects.push(subject);
    const { loginKey } = JSON.parse(await cli("user", "create", "--subject", subject, ...createFlags)) as {
      loginKey: string;
    };
    return { subject, loginKey };
  }

  /** Signs `user` in and runs consent + code exchange for `scope`. */
  async function login(user: { subject: string; loginKey: string }, scope = everything) {
    const pending = await authorize(user, scope);
    return { ...(await pending.exchange()), ...pending };
  }

  /** Signs in and consents, returning the issued code unexchanged. */
  async function authorize(user: { subject: string; loginKey: string }, scope = everything) {
    const redirectUri = "https://client.example/cb";
    const { clientId } = await provider.registerClient({ redirectUris: [redirectUri] });
    clients.push(clientId);
    const binding = randomUUID();
    const session = await provider.sessions.login(
      user.loginKey,
      await provider.sessions.challenge("login", null, binding),
      binding,
    );
    const verifier = randomBytes(32).toString("base64url");
    const { interactionId } = await provider.handleAuthorize({
      clientId,
      redirectUri,
      codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
      codeChallengeMethod: "S256",
      scope,
      resource: origin + "/mcp",
    });
    const page = await provider.consentPage(session, interactionId);
    const redirect = new URL(await provider.consent(session, interactionId, page.challenge, true));
    const exchange = () =>
      provider.handleToken({
        grantType: "authorization_code",
        clientId,
        redirectUri,
        code: redirect.searchParams.get("code")!,
        codeVerifier: verifier,
      });
    return { exchange, clientId, session, interactionId };
  }

  async function makeOwner(accessToken: string): Promise<string> {
    const client = new Client({ name: "roles-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(origin + "/mcp"), {
        requestInit: { headers: { authorization: "Bearer " + accessToken } },
      }),
    );
    try {
      return JSON.stringify(
        await client.callTool({ name: "make_owner", arguments: { agentId: "missing", ownerId: null } }),
      );
    } finally {
      await client.close();
    }
  }

  const ROLE_DENIED = /requires a role that grants it/;
  const rolesOf = async (subject: string) =>
    (await db.authUser.findFirstOrThrow({ where: { principal: { subject } } })).roles;

  it("issuing doesn't depend on roles: a member may consent to agents:admin, but make_owner is refused", async () => {
    const token = await login(await newUser());
    expect(token.scope).toBe("agents:read agents:write agents:admin packages:approve memory:write");
    expect(await provider.verifyBearer(token.accessToken)).toMatchObject({ wardbyRoles: [] });
    expect(await makeOwner(token.accessToken)).toMatch(ROLE_DENIED);
  });

  it("a package-approver is refused make_owner; an admin passes; the scope is still required", async () => {
    const approver = await login(await newUser("--role", "package-approver"));
    expect(await provider.verifyBearer(approver.accessToken)).toMatchObject({ wardbyRoles: ["package-approver"] });
    expect(await makeOwner(approver.accessToken)).toMatch(ROLE_DENIED);

    const user = await newUser("--role", "admin");
    const full = await login(user);
    expect(await makeOwner(full.accessToken)).not.toMatch(/requires a role|Insufficient scope/);
    const narrow = await login(user, "agents:read agents:write");
    expect(await makeOwner(narrow.accessToken)).toContain("Insufficient scope; this operation requires: agents:admin");
  });

  it("roles are read live: a role added directly in the database applies to the next request", async () => {
    const user = await newUser();
    const token = await login(user);
    expect(await makeOwner(token.accessToken)).toMatch(ROLE_DENIED);
    await db.authUser.updateMany({ where: { principal: { subject: user.subject } }, data: { roles: ["admin"] } });
    expect(await makeOwner(token.accessToken)).not.toMatch(/requires a role|Insufficient scope/);
    await expect(provider.verifyBearer(token.accessToken)).resolves.toMatchObject({ wardbyRoles: ["admin"] });
  });

  it("granting a role through the CLI also signs the user out: old families can't gain the new role's reach", async () => {
    const user = await newUser();
    const token = await login(user);
    expect(JSON.parse(await cli("user", "grant", "--subject", user.subject, "--role", "admin"))).toMatchObject({
      roles: ["admin"],
      revokedGrants: true,
    });
    await expect(provider.verifyBearer(token.accessToken)).rejects.toThrow();
    await expect(
      provider.handleToken({ grantType: "refresh_token", clientId: token.clientId, refreshToken: token.refreshToken }),
    ).rejects.toThrow(/revoked/);
    await expect(provider.sessions.get(token.session)).rejects.toThrow();
    // A fresh sign-in and consent gets the role.
    const fresh = await login(user);
    expect(await makeOwner(fresh.accessToken)).not.toMatch(/requires a role|Insufficient scope/);
  });

  it.each([
    ["--role", "admin"],
    ["--revoke-role", "admin"],
  ])("an unexchanged authorization code dies with a role change (%s %s)", async (flag, role) => {
    const user = await newUser(...(flag === "--revoke-role" ? ["--role", "admin"] : []));
    const pending = await authorize(user);
    await cli("user", "grant", "--subject", user.subject, flag, role);
    await expect(pending.exchange()).rejects.toThrow(/Invalid grant/);
  });

  it("roles are read live: a role removed directly in the database refuses the next request", async () => {
    const user = await newUser("--role", "admin");
    const token = await login(user);
    await db.authUser.updateMany({ where: { principal: { subject: user.subject } }, data: { roles: [] } });
    expect(await makeOwner(token.accessToken)).toMatch(ROLE_DENIED);
  });

  it("revoking any role through the CLI revokes the user's grant families and sessions in the same step", async () => {
    const user = await newUser("--role", "admin", "--role", "package-approver");
    const token = await login(user);
    const out = JSON.parse(await cli("user", "grant", "--subject", user.subject, "--revoke-role", "admin")) as {
      roles: string[];
      revokedGrants: boolean;
    };
    expect(out).toEqual({ subject: user.subject, roles: ["package-approver"], revokedGrants: true });
    await expect(provider.verifyBearer(token.accessToken)).rejects.toThrow();
    await expect(
      provider.handleToken({ grantType: "refresh_token", clientId: token.clientId, refreshToken: token.refreshToken }),
    ).rejects.toThrow(/revoked/);
    await expect(provider.sessions.get(token.session)).rejects.toThrow();
    const families = await db.oAuthFamily.findMany({ where: { user: { principal: { subject: user.subject } } } });
    expect(families.length).toBeGreaterThan(0);
    expect(families.every((f) => f.revokedAt !== null)).toBe(true);
    // Granting the role again later can't resurrect the old grant.
    await cli("user", "grant", "--subject", user.subject, "--role", "admin");
    await expect(provider.verifyBearer(token.accessToken)).rejects.toThrow();
  });

  it("a no-op role change (revoking a role the user doesn't hold) revokes nothing", async () => {
    const user = await newUser("--role", "package-approver");
    const token = await login(user);
    const out = JSON.parse(await cli("user", "grant", "--subject", user.subject, "--revoke-role", "admin")) as {
      revokedGrants: boolean;
    };
    expect(out.revokedGrants).toBe(false);
    await expect(provider.verifyBearer(token.accessToken)).resolves.toMatchObject({
      wardbyRoles: ["package-approver"],
    });
  });

  it("scopes still only narrow: empty request, empty token; refresh keeps the consented scope", async () => {
    const user = await newUser("--role", "admin");
    const empty = await login(user, "");
    expect(empty.scope).toBe("");
    expect((await provider.verifyBearer(empty.accessToken)).scopes).toEqual([]);
    const narrow = await login(user, "agents:read");
    const refreshed = await provider.handleToken({
      grantType: "refresh_token",
      clientId: narrow.clientId,
      refreshToken: narrow.refreshToken,
    });
    expect(refreshed.scope).toBe("agents:read");
  });

  it("memory:write is supported and reaches set_agent_memory's handler for a member", async () => {
    const token = await login(await newUser(), "memory:write");
    expect(token.scope).toBe("memory:write");
    const client = new Client({ name: "roles-test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(origin + "/mcp"), {
        requestInit: { headers: { authorization: "Bearer " + token.accessToken } },
      }),
    );
    const result = JSON.stringify(
      await client.callTool({ name: "set_agent_memory", arguments: { agentId: "missing", key: "k", content: "c" } }),
    );
    await client.close();
    expect(result).not.toMatch(/Insufficient scope|requires a role/);
  });

  it("the consent page lists exactly the supported scopes approval issues", async () => {
    const user = await newUser();
    const token = await login(user, "agents:read");
    const { interactionId } = await provider.handleAuthorize({
      clientId: token.clientId,
      redirectUri: "https://client.example/cb",
      codeChallenge: "A".repeat(43),
      codeChallengeMethod: "S256",
      scope: everything,
      resource: origin + "/mcp",
    });
    const html = await (
      await fetch(origin + "/consent?interaction=" + interactionId, {
        headers: { cookie: "wardby-dev-session=" + token.session },
      })
    ).text();
    expect(html).toContain("agents:read agents:write agents:admin packages:approve memory:write");
    expect(html).not.toContain("not-a-scope");
  });

  it("CLI: create/grant/revoke/list, loud rejection of unknown roles or flags, no implicit user creation", async () => {
    const user = await newUser();
    const list = async () =>
      (JSON.parse(await cli("user", "list")) as { principal: { subject: string }; roles: string[] }[]).find(
        (u) => u.principal.subject === user.subject,
      )?.roles;
    expect(await list()).toEqual([]);
    await cli("user", "grant", "--subject", user.subject, "--role", "package-approver", "--role", "admin");
    expect(await list()).toEqual(["admin", "package-approver"]);
    await cli("user", "grant", "--subject", user.subject, "--revoke-role", "admin");
    expect(await list()).toEqual(["package-approver"]);

    await expect(cli("user", "grant", "--subject", user.subject)).rejects.toThrow(/--role/);
    await expect(cli("user", "grant", "--subject", user.subject, "--role", "root")).rejects.toThrow(
      /Unknown role "root"/,
    );
    await expect(cli("user", "grant", "--subject", user.subject, "--revoke-role", "Admin")).rejects.toThrow(
      /Unknown role/,
    );
    await expect(
      cli("user", "grant", "--subject", user.subject, "--role", "admin", "--revoke-role", "admin"),
    ).rejects.toThrow(/both grant and revoke/);
    await expect(cli("user", "create", "--subject", "x-" + randomUUID(), "--role", "root")).rejects.toThrow(
      /Unknown role/,
    );
    await expect(cli("user", "grant", "--subject", user.subject, "--role", "admin", "--admin")).rejects.toThrow(
      /--admin/,
    );
    await expect(cli("key", "create", "--subject", user.subject, "--role", "admin")).rejects.toThrow(/--role/);
    await expect(cli("user", "disable", "--subject", user.subject, "--role", "admin")).rejects.toThrow(/--role/);
    await expect(cli("user", "list", "--role", "admin")).rejects.toThrow(/--role/);
    await expect(cli("key", "revoke", "some-id", "--role", "admin")).rejects.toThrow(/no flags/);
    const ghost = "ghost-" + randomUUID();
    await expect(cli("user", "grant", "--subject", ghost, "--role", "admin")).rejects.toThrow(/Unknown user/);
    expect(await db.principal.findUnique({ where: { subject: ghost } })).toBeNull();
    expect(await rolesOf(user.subject)).toEqual(["package-approver"]);
  });

  it("the migration default gives existing users no roles", async () => {
    const subject = "role-legacy-" + randomUUID();
    subjects.push(subject);
    const principal = await db.principal.create({ data: { subject } });
    // Insert the way a pre-migration row looked: no roles value at all.
    await db.$executeRaw`INSERT INTO "AuthUser" ("id", "principalId", "updatedAt") VALUES (${randomUUID()}, ${principal.id}, now())`;
    expect(await rolesOf(subject)).toEqual([]);
    const token = await login({ subject, loginKey: await identities.createKey(subject) });
    expect(await makeOwner(token.accessToken)).toMatch(ROLE_DENIED);
  });
});
