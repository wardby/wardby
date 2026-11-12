import { describe, expect, it } from "vitest";
import { buildMcpServer } from "../server.js";
import { createStdioLinkHost } from "../transport/stdio-link-host.js";
import {
  isOAuthLoopbackLinkPayload,
  mintOAuthLoopbackLink,
  OAUTH_LOOPBACK_LINK_PATH,
  oauthLoopbackCommand,
  parseOAuthLoopbackLink,
  verifyOAuthLoopbackLink,
  type OAuthLoopbackLinkPayload,
} from "./oauth-loopback-link.js";

const NOW = new Date("2026-11-12T10:00:00Z");
const EXP = NOW.getTime() + 10 * 60_000;

function server() {
  return buildMcpServer({ providers: {} as never, db: {} as never, config: { canonicalUri: "https://host/mcp" } });
}

function payload(overrides: Partial<OAuthLoopbackLinkPayload> = {}): OAuthLoopbackLinkPayload {
  return {
    kind: "oauth-loopback",
    principalId: "p1",
    name: "browserstack",
    resource: "https://mcp.example/mcp",
    scope: "read",
    clientId: "client-1",
    aud: "http",
    exp: EXP,
    ...overrides,
  };
}

describe("OAuth loopback link", () => {
  it("puts the token in the fragment, and parses back to origin and token", async () => {
    const mcp = server();
    const link = await mintOAuthLoopbackLink((p) => mcp.mintRequestState(p), "https://wardby.example/", payload());
    const url = new URL(link);
    expect(url.origin).toBe("https://wardby.example");
    expect(url.pathname).toBe(OAUTH_LOOPBACK_LINK_PATH);
    expect(url.search).toBe("");
    expect(url.hash.length).toBeGreaterThan(1);
    const parsed = parseOAuthLoopbackLink(link);
    expect(parsed).toEqual({ origin: "https://wardby.example", token: url.hash.slice(1) });
    const verified = await verifyOAuthLoopbackLink(parsed!.token, {
      verify: (t) => mcp.verifyRequestState(t),
      audience: "http",
      now: () => NOW,
    });
    expect(verified).toEqual({ ok: true, payload: payload() });
  });

  it("refuses anything that is not a loopback link", () => {
    for (const bad of [
      "not a url",
      "ftp://wardby.example/oauth/loopback#t",
      "https://u:p@wardby.example/oauth/loopback#t",
      "https://wardby.example/oauth/loopback?t=x#t",
      "https://wardby.example/oauth/loopback",
      "https://wardby.example/oauth/loopback#",
      "https://wardby.example/other#t",
    ]) {
      expect(parseOAuthLoopbackLink(bad)).toBeNull();
    }
  });

  it("refuses an expired link, the other audience, a tampered token and a missing one, with one fixed code", async () => {
    const mcp = server();
    const verify = (t: string) => mcp.verifyRequestState(t);
    const token = await mcp.mintRequestState(payload());
    const at = (ms: number) => () => new Date(ms);
    expect((await verifyOAuthLoopbackLink(token, { verify, audience: "http", now: at(EXP - 1) })).ok).toBe(true);
    for (const result of [
      await verifyOAuthLoopbackLink(token, { verify, audience: "http", now: at(EXP) }),
      await verifyOAuthLoopbackLink(token, { verify, audience: "stdio", now: () => NOW }),
      await verifyOAuthLoopbackLink(`${token.slice(0, -2)}xx`, { verify, audience: "http", now: () => NOW }),
      await verifyOAuthLoopbackLink(null, { verify, audience: "http", now: () => NOW }),
      await verifyOAuthLoopbackLink(await mcp.mintRequestState({ kind: "run-transcript", aud: "http" }), {
        verify,
        audience: "http",
        now: () => NOW,
      }),
    ]) {
      expect(result).toEqual({ ok: false, error: "link_invalid" });
      expect(JSON.stringify(result)).not.toContain(token);
    }
  });

  it("allows the operator flag on a stdio link only", () => {
    expect(isOAuthLoopbackLinkPayload(payload({ aud: "stdio", operator: true }))).toBe(true);
    expect(isOAuthLoopbackLinkPayload(payload({ aud: "http", operator: true }))).toBe(false);
    expect(isOAuthLoopbackLinkPayload(payload({ scope: "" }))).toBe(false);
    expect(isOAuthLoopbackLinkPayload({ ...payload(), kind: "run-transcript" })).toBe(false);
  });

  it("builds a single-quoted command", () => {
    expect(oauthLoopbackCommand("https://w.example/oauth/loopback#abc")).toBe(
      "npx @wardby/cli@latest secret connect 'https://w.example/oauth/loopback#abc'",
    );
    expect(() => oauthLoopbackCommand("https://w.example/oauth/loopback#a'b")).toThrow();
  });

  it("the stdio link host names its loopback origin", async () => {
    const host = createStdioLinkHost({});
    const origin = await host.origin();
    expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await host.origin()).toBe(origin);
    const res = await fetch(`${origin}${OAUTH_LOOPBACK_LINK_PATH}`);
    expect(res.status).toBe(404);
  });
});
