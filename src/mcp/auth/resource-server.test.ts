import { describe, it, expect, vi } from "vitest";
import type { AuthProvider, VerifiedToken } from "../../providers/auth/types.js";
import { AudienceError } from "../../providers/auth/types.js";
import { protectedResourceMetadata, authenticate, requireScope } from "./resource-server.js";
import { McpError } from "../errors.js";

const CANONICAL_URI = "https://host/mcp";

function fakeAuthProvider(verifyBearer: AuthProvider["verifyBearer"]): AuthProvider {
  return {
    authorizeUrl: () => "",
    exchangeCode: async () => ({ idToken: "", accessToken: "" }),
    refresh: async () => ({ idToken: "", accessToken: "" }),
    profile: async () => ({ subject: "", roles: [] }),
    verifyBearer,
  };
}

function fakeDb() {
  return {
    principal: {
      upsert: vi.fn(async ({ where }: { where: { subject: string } }) => ({
        id: `principal-${where.subject}`,
        subject: where.subject,
        createdAt: new Date(),
      })),
    },
  } as unknown as import("@prisma/client").PrismaClient;
}

const fakeProviders = {} as unknown as import("../../providers/index.js").ProviderRegistry;

describe("protectedResourceMetadata", () => {
  it("matches RFC 9728 shape and constructs the well-known URI by inserting before the path", () => {
    const meta = protectedResourceMetadata({
      canonicalUri: CANONICAL_URI,
      authorizationServers: ["https://idp.example.com"],
    });
    expect(meta.resource).toBe(CANONICAL_URI);
    expect(meta.authorization_servers).toEqual(["https://idp.example.com"]);
    expect(meta.scopes_supported.length).toBeGreaterThan(0);
    expect(meta.bearer_methods_supported).toEqual(["header"]);
  });
});

describe("authenticate", () => {
  it("valid token resolves a context with principal + scopes", async () => {
    const verified: VerifiedToken = { subject: "user-1", roles: [], scopes: ["agents:read", "agents:write"] };
    const authProvider = fakeAuthProvider(async () => verified);
    const db = fakeDb();
    const ctx = await authenticate(
      { authorization: "Bearer good-token" },
      { authProvider, db, providers: fakeProviders, canonicalUri: CANONICAL_URI },
    );
    expect(ctx.principal.subject).toBe("user-1");
    expect(ctx.scopes.has("agents:write")).toBe(true);
  });

  it("missing Authorization header -> 401 challenge", async () => {
    const authProvider = fakeAuthProvider(async () => {
      throw new Error("should not be called");
    });
    await expect(
      authenticate({}, { authProvider, db: fakeDb(), providers: fakeProviders, canonicalUri: CANONICAL_URI }),
    ).rejects.toMatchObject({ httpStatus: 401 } satisfies Partial<McpError>);
  });

  it("expired/invalid token -> 401 challenge", async () => {
    const authProvider = fakeAuthProvider(async () => {
      throw new Error("jwt expired");
    });
    await expect(
      authenticate(
        { authorization: "Bearer expired" },
        { authProvider, db: fakeDb(), providers: fakeProviders, canonicalUri: CANONICAL_URI },
      ),
    ).rejects.toMatchObject({ httpStatus: 401 });
  });

  it("wrong audience -> 401", async () => {
    const authProvider = fakeAuthProvider(async () => {
      throw new AudienceError("wrong audience");
    });
    await expect(
      authenticate(
        { authorization: "Bearer wrong-aud" },
        { authProvider, db: fakeDb(), providers: fakeProviders, canonicalUri: CANONICAL_URI },
      ),
    ).rejects.toMatchObject({ httpStatus: 401 });
  });

  it("bearer in query string is never read; missing header is rejected regardless", async () => {
    const authProvider = fakeAuthProvider(async () => {
      throw new Error("should not be called");
    });
    // No `authorization` header at all — a query-string token, even if a
    // caller tried to sneak one into `headers` under a different key, is
    // structurally invisible to authenticate() since it only reads
    // `headers.authorization`.
    await expect(
      authenticate({ query: { access_token: "sneaky" } } as never, {
        authProvider,
        db: fakeDb(),
        providers: fakeProviders,
        canonicalUri: CANONICAL_URI,
      }),
    ).rejects.toMatchObject({ httpStatus: 401 });
  });
});

describe("requireScope", () => {
  it("passes when the context holds the required scope", () => {
    const ctx = {
      principal: {} as never,
      scopes: new Set(["agents:write"]),
      canonicalUri: CANONICAL_URI,
      providers: fakeProviders,
      db: fakeDb(),
      clientSupportsTasks: false,
      mcpReq: { requestState: () => undefined },
    };
    expect(() => requireScope(ctx, CANONICAL_URI, "agents:write")).not.toThrow();
  });

  it("throws 403 with a WWW-Authenticate challenge listing all required scopes", () => {
    const ctx = {
      principal: {} as never,
      scopes: new Set(["agents:read"]),
      canonicalUri: CANONICAL_URI,
      providers: fakeProviders,
      db: fakeDb(),
      clientSupportsTasks: false,
      mcpReq: { requestState: () => undefined },
    };
    try {
      requireScope(ctx, CANONICAL_URI, "agents:write", "tools:write");
      expect.unreachable("requireScope should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(McpError);
      const mcpErr = err as McpError;
      expect(mcpErr.httpStatus).toBe(403);
      expect(mcpErr.wwwAuthenticate).toContain('scope="agents:write tools:write"');
      expect(mcpErr.wwwAuthenticate).toContain("resource_metadata=");
    }
  });
});
