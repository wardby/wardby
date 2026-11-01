import { describe, expect, it, vi } from "vitest";
import {
  PRIVILEGED_SCOPES,
  ROLE_NAMES,
  ROLE_PERMISSIONS,
  SCOPES_SUPPORTED,
  authenticate,
  permissionsOf,
  requireAnyScope,
  requireScope,
} from "./resource-server.js";
import { McpError } from "../errors.js";
import { localOperatorContext, registerAllTools } from "../index.js";
import type { WardbyMcpServer } from "../server.js";
import type { McpRequestContext } from "../context.js";
import type { AuthProvider, VerifiedToken } from "../../providers/auth/types.js";

const URI = "https://host/mcp";

/** Every scope a registered tool or request handler demands, collected without building a real server. */
function requiredScopes(): Map<string, string[]> {
  const byTool = new Map<string, string[]>();
  const fake = {
    registerTool: (spec: { name: string; scope: string | string[] }) =>
      byTool.set(spec.name, Array.isArray(spec.scope) ? spec.scope : [spec.scope]),
    registerRequestHandler: (method: string, scope: string | string[]) =>
      byTool.set(method, Array.isArray(scope) ? scope : [scope]),
  } as unknown as WardbyMcpServer;
  registerAllTools(fake, {
    secretElicitationUrl: async () => "https://example/elicit",
    secretElicitationProtocol: false,
  });
  return byTool;
}

function ctx(scopes: string[], roles?: string[]): McpRequestContext {
  return { scopes: new Set(scopes), roles } as unknown as McpRequestContext;
}

function denial(fn: () => void): McpError | undefined {
  try {
    fn();
  } catch (err) {
    return err as McpError;
  }
  return undefined;
}

describe("supported scopes", () => {
  it("advertises memory:write, so set/delete_agent_memory are reachable over OAuth and stdio", () => {
    expect(SCOPES_SUPPORTED).toContain("memory:write");
    const tools = requiredScopes();
    expect(tools.get("set_agent_memory")).toEqual(["memory:write"]);
    expect(tools.get("delete_agent_memory")).toEqual(["memory:write"]);
    expect(PRIVILEGED_SCOPES).not.toContain("memory:write");
  });

  it("registers the host account tools with non-privileged scopes (linking is self-service)", () => {
    const tools = requiredScopes();
    expect(tools.get("link_host_account")).toEqual(["agents:write"]);
    expect(tools.get("get_host_account")).toEqual(["agents:read"]);
    expect(tools.get("unlink_host_account")).toEqual(["agents:write"]);
  });

  it("every scope a tool requires is advertised (no tool is unreachable)", () => {
    for (const [name, scopes] of requiredScopes())
      for (const scope of scopes) expect(SCOPES_SUPPORTED, `${name} needs ${scope}`).toContain(scope);
  });

  it("treats exactly admin:view, agents:admin, packages:approve, services:manage, models:admin, power:manage and hosts:admin as privileged", () => {
    expect([...PRIVILEGED_SCOPES].sort()).toEqual([
      "admin:view",
      "agents:admin",
      "hosts:admin",
      "models:admin",
      "packages:approve",
      "power:manage",
      "services:manage",
    ]);
    for (const scope of PRIVILEGED_SCOPES) expect(SCOPES_SUPPORTED).toContain(scope);
  });

  it("built-in roles: admin grants every permission, package-approver, service-manager and model-manager one each", () => {
    expect([...ROLE_NAMES].sort()).toEqual([
      "admin",
      "host-manager",
      "model-manager",
      "package-approver",
      "service-manager",
    ]);
    expect([...ROLE_PERMISSIONS.admin].sort()).toEqual([
      "admin:view",
      "agents:admin",
      "hosts:admin",
      "models:admin",
      "packages:approve",
      "power:manage",
      "services:manage",
    ]);
    expect(ROLE_PERMISSIONS["package-approver"]).toEqual(["packages:approve"]);
    expect(ROLE_PERMISSIONS["service-manager"]).toEqual(["services:manage"]);
    expect(ROLE_PERMISSIONS["model-manager"]).toEqual(["models:admin"]);
    for (const perms of Object.values(ROLE_PERMISSIONS)) for (const p of perms) expect(PRIVILEGED_SCOPES).toContain(p);
    expect([...permissionsOf(["bogus", "package-approver"])]).toEqual(["packages:approve"]);
    expect([...permissionsOf(["service-manager"])]).toEqual(["services:manage"]);
    expect([...permissionsOf(["model-manager"])]).toEqual(["models:admin"]);
    expect(permissionsOf(null).size).toBe(0);
  });
});

const PACKAGES = ["packages:approve", "agents:admin"] as const;

describe("privileged operations need the scope AND a role granting it", () => {
  it("a member (no roles) holding agents:admin is refused with a role error, not a scope challenge", () => {
    for (const roles of [[], undefined]) {
      const err = denial(() => requireScope(ctx(["agents:admin"], roles), URI, "agents:admin"));
      expect(err).toBeInstanceOf(McpError);
      expect(err?.httpStatus).toBe(403);
      expect(err?.message).toMatch(/requires a role that grants it \(admin\)/);
      // Re-authorizing for more scopes can't help, so no scope challenge.
      expect(err?.wwwAuthenticate ?? "").not.toContain("scope=");
    }
  });

  it("admin can do all three privileged operations when the token carries the scope", () => {
    expect(denial(() => requireScope(ctx(["agents:admin"], ["admin"]), URI, "agents:admin"))).toBeUndefined();
    for (const scope of PACKAGES)
      expect(denial(() => requireAnyScope(ctx([scope], ["admin"]), URI, ...PACKAGES))).toBeUndefined();
  });

  it("package-approver can approve packages with packages:approve, but not make_owner / workerImageRef", () => {
    const approver = ["package-approver"];
    expect(denial(() => requireAnyScope(ctx(["packages:approve"], approver), URI, ...PACKAGES))).toBeUndefined();
    // Holding agents:admin as a scope doesn't help: no role of theirs grants it.
    expect(
      denial(() => requireAnyScope(ctx(["agents:admin", "packages:approve"], approver), URI, ...PACKAGES)),
    ).toBeUndefined();
    // Their role DOES grant packages:approve; the token just lacks it — so the
    // fix is re-authorizing, and they get a scope challenge naming it, not a
    // misleading "agents:admin requires admin" 403.
    const missingScope = denial(() => requireAnyScope(ctx(["agents:admin"], approver), URI, ...PACKAGES));
    expect(missingScope?.message).toMatch(/Insufficient scope; this operation requires: packages:approve$/);
    expect(missingScope?.wwwAuthenticate).toContain('scope="packages:approve"');
    const owner = denial(() => requireScope(ctx(["agents:admin"], approver), URI, "agents:admin"));
    expect(owner?.httpStatus).toBe(403);
    expect(owner?.message).toMatch(/agents:admin requires a role that grants it \(admin\)/);
  });

  it("a member can do none of them", () => {
    expect(denial(() => requireScope(ctx(["agents:admin"], []), URI, "agents:admin"))?.httpStatus).toBe(403);
    for (const scope of PACKAGES)
      expect(denial(() => requireAnyScope(ctx([scope], []), URI, ...PACKAGES))?.message).toMatch(/requires a role/);
  });

  it("the scope is still required for each, whatever the roles", () => {
    const err = denial(() => requireScope(ctx(["agents:write"], ["admin"]), URI, "agents:admin"));
    expect(err?.message).toMatch(/Insufficient scope/);
    expect(denial(() => requireAnyScope(ctx(["agents:write"], ["admin"]), URI, ...PACKAGES))?.message).toMatch(
      /Insufficient scope.*packages:approve/,
    );
    expect(
      denial(() => requireAnyScope(ctx(["agents:write"], ["package-approver"]), URI, ...PACKAGES))?.message,
    ).toMatch(/Insufficient scope/);
  });

  it("unknown role names grant nothing", () => {
    expect(denial(() => requireScope(ctx(["agents:admin"], ["root"]), URI, "agents:admin"))?.httpStatus).toBe(403);
  });

  it("non-privileged scopes don't depend on roles", () => {
    expect(denial(() => requireScope(ctx(["agents:write"], []), URI, "agents:write"))).toBeUndefined();
  });

  it("service-manager and admin may manage the service catalog; nobody else, and never without the scope", () => {
    const manage = (scopes: string[], roles?: string[]) =>
      denial(() => requireScope(ctx(scopes, roles), URI, "services:manage"));
    expect(manage(["services:manage"], ["service-manager"])).toBeUndefined();
    expect(manage(["services:manage"], ["admin"])).toBeUndefined();
    expect(manage(["services:manage"], ["package-approver"])?.message).toMatch(/requires a role that grants it/);
    expect(manage(["services:manage"], [])?.message).toMatch(/requires a role that grants it/);
    expect(manage(["agents:admin"], ["admin"])?.message).toMatch(
      /Insufficient scope; this operation requires: services:manage$/,
    );
    // A service-manager is not an admin and not a package approver.
    expect(
      denial(() => requireScope(ctx(["agents:admin"], ["service-manager"]), URI, "agents:admin"))?.message,
    ).toMatch(/requires a role that grants it/);
    expect(
      denial(() => requireAnyScope(ctx(["packages:approve"], ["service-manager"]), URI, ...PACKAGES))?.message,
    ).toMatch(/requires a role that grants it/);
  });

  it("admin:view is honoured only for the admin role", () => {
    const base = { scopes: ["admin:view"] };
    expect(() => requireScope(ctx([...base.scopes], ["admin"]), URI, "admin:view")).not.toThrow();
    expect(() => requireScope(ctx([...base.scopes], []), URI, "admin:view")).toThrow(/Forbidden/);
    expect(() => requireScope(ctx([...base.scopes], ["service-manager"]), URI, "admin:view")).toThrow(/Forbidden/);
  });

  it("grants models:admin to admin and model-manager only, and treats it as privileged", () => {
    expect(PRIVILEGED_SCOPES).toContain("models:admin");
    expect(SCOPES_SUPPORTED).toContain("models:admin");
    expect(permissionsOf(["admin"]).has("models:admin")).toBe(true);
    expect(permissionsOf(["model-manager"])).toEqual(new Set(["models:admin"]));
    expect(permissionsOf(["service-manager"]).has("models:admin")).toBe(false);
  });

  it("grants hosts:admin to admin and host-manager only, and treats it as privileged", () => {
    expect(PRIVILEGED_SCOPES).toContain("hosts:admin");
    expect(SCOPES_SUPPORTED).toContain("hosts:admin");
    expect(permissionsOf(["admin"]).has("hosts:admin")).toBe(true);
    expect(permissionsOf(["host-manager"])).toEqual(new Set(["hosts:admin"]));
    expect(permissionsOf(["model-manager"]).has("hosts:admin")).toBe(false);
  });
});

describe("power:manage", () => {
  it("is supported, privileged, granted by admin and by no other built-in role", () => {
    expect(SCOPES_SUPPORTED).toContain("power:manage");
    expect(PRIVILEGED_SCOPES).toContain("power:manage");
    expect(ROLE_NAMES.filter((role) => ROLE_PERMISSIONS[role].includes("power:manage"))).toEqual(["admin"]);
    const tools = requiredScopes();
    expect(tools.get("power_sleep")).toEqual(["power:manage"]);
    expect(tools.get("power_status")).toEqual(["power:manage"]);
    expect(() => requireScope(ctx(["power:manage"], ["admin"]), URI, "power:manage")).not.toThrow();
    for (const roles of [[], ["model-manager"], ["service-manager"], ["package-approver"]])
      expect(denial(() => requireScope(ctx(["power:manage"], roles), URI, "power:manage"))?.httpStatus).toBe(403);
  });
});

describe("role plumbing", () => {
  const db = {
    principal: {
      upsert: vi.fn(async ({ where }: { where: { subject: string } }) => ({
        id: "p-" + where.subject,
        subject: where.subject,
        createdAt: new Date(),
      })),
    },
  } as unknown as import("#prisma").PrismaClient;
  const provider = (v: VerifiedToken) => ({ verifyBearer: async () => v }) as unknown as AuthProvider;

  it("authenticate carries the provider's live wardby roles (only known ones) onto the request context", async () => {
    const deps = { db, providers: {} as never, canonicalUri: URI };
    const withRoles = await authenticate(
      { authorization: "Bearer t" },
      {
        ...deps,
        authProvider: provider({
          subject: "a",
          scopes: [],
          wardbyRoles: ["package-approver", "root"],
          roles: ["admin"],
        }),
      },
    );
    // The IdP's raw `roles` claim never becomes a wardby role.
    expect(withRoles.roles).toEqual(["package-approver"]);
    const none = await authenticate(
      { authorization: "Bearer t" },
      { ...deps, authProvider: provider({ subject: "m", scopes: [] }) },
    );
    expect(none.roles).toEqual([]);
  });

  it("stdio's local operator holds every role and every supported scope", () => {
    const local = localOperatorContext({ id: "p", subject: "local", createdAt: new Date() }, {} as never, db);
    expect([...(local.roles ?? [])].sort()).toEqual([...ROLE_NAMES].sort());
    expect([...local.scopes].sort()).toEqual([...SCOPES_SUPPORTED].sort());
    expect(denial(() => requireScope(local, URI, "agents:admin"))).toBeUndefined();
    expect(denial(() => requireAnyScope(local, URI, ...PACKAGES))).toBeUndefined();
  });
});
