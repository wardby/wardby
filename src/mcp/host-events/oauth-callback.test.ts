import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../core/oauth-link.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../core/oauth-link.js")>()),
  completeOAuthCallback: vi.fn(),
}));
import { completeOAuthCallback } from "../../core/oauth-link.js";
import { handleOAuthCallback, type OAuthCallbackDeps } from "./oauth-callback.js";

function fakeRes() {
  const headers: Record<string, string> = {};
  const out = { status: 0, body: "", headers };
  const res = {
    setHeader: (k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    },
    writeHead(status: number, h: Record<string, string> = {}) {
      out.status = status;
      for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v;
      return res;
    },
    end(body?: string) {
      out.body = body ?? "";
      return res;
    },
  };
  return { res: res as unknown as ServerResponse, out };
}

const deps: OAuthCallbackDeps = {
  db: {} as never,
  cipher: {} as never,
  adapters: new Map(),
  redirectUri: () => "https://host/hosts/github/user-callback",
};
/** What the /hosts/github/user-callback route passes. */
const github = { target: "GitHub", tool: "link_host_account" };
const url = (query: string) => new URL(`https://host/hosts/github/user-callback?${query}`);

function expectSecurityHeaders(headers: Record<string, string>) {
  expect(headers["cache-control"]).toBe("no-store");
  expect(headers["referrer-policy"]).toBe("no-referrer");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["content-security-policy"]).toMatch(/^default-src 'none'/);
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
}

describe("GitHub user callback page", () => {
  it("shows the one-time code, the GitHub login, the wardby account, and a warning, with security headers", async () => {
    vi.mocked(completeOAuthCallback).mockResolvedValueOnce({
      kind: "confirm",
      code: "ABCD-EFGH",
      signedInAs: "@octo",
      target: "GitHub",
      tool: "link_host_account",
      subject: "<script>alert(1)</script>",
    });
    const { res, out } = fakeRes();
    await handleOAuthCallback(url("code=c0de&state=st4te"), res, deps, github);
    expect(out.status).toBe(200);
    expectSecurityHeaders(out.headers);
    expect(out.body).toContain("ABCD-EFGH");
    expect(out.body).toContain("@octo");
    expect(out.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out.body).not.toContain("<script>");
    expect(out.body).toMatch(/did not start this/i);
    expect(vi.mocked(completeOAuthCallback).mock.calls[0][0]).toMatchObject({
      state: "st4te",
      code: "c0de",
      redirectUri: deps.redirectUri,
    });
  });

  it("answers a generic 400 for an unknown, used, or expired state", async () => {
    vi.mocked(completeOAuthCallback).mockResolvedValueOnce({ kind: "invalid" });
    const { res, out } = fakeRes();
    await handleOAuthCallback(url("code=c&state=nope"), res, deps, github);
    expect(out.status).toBe(400);
    expectSecurityHeaders(out.headers);
    expect(out.body).toMatch(/invalid or has expired/);
  });

  it("reports a failed exchange without detail", async () => {
    vi.mocked(completeOAuthCallback).mockResolvedValueOnce({ kind: "failed" });
    const { res, out } = fakeRes();
    await handleOAuthCallback(url("code=c&state=s"), res, deps, github);
    expect(out.status).toBe(502);
  });

  it("shows a cancelled page when the user declines, without touching the link", async () => {
    vi.mocked(completeOAuthCallback).mockClear();
    const { res, out } = fakeRes();
    await handleOAuthCallback(url("error=access_denied&state=s"), res, deps, github);
    expect(out.status).toBe(200);
    expectSecurityHeaders(out.headers);
    expect(out.body).toMatch(/cancelled/i);
    const other = fakeRes();
    await handleOAuthCallback(url("error=<b>weird</b>&state=s"), other.res, deps, github);
    expect(other.out.status).toBe(400);
    expect(other.out.body).not.toContain("<b>");
    expect(completeOAuthCallback).not.toHaveBeenCalled();
  });

  it("keeps the GitHub page wording word for word on the GitHub route", async () => {
    const body = async (query: string) => {
      const { res, out } = fakeRes();
      await handleOAuthCallback(url(query), res, deps, github);
      return out.body;
    };
    vi.mocked(completeOAuthCallback).mockResolvedValueOnce({
      kind: "confirm",
      code: "ABCD-EFGH",
      signedInAs: "@octo",
      target: "GitHub",
      tool: "link_host_account",
      subject: "alice",
    });
    const confirm = await body("code=c&state=s");
    expect(confirm).toContain("<title>wardby: Confirm the link</title>");
    expect(confirm).toContain(
      "<p>Signed in to GitHub as <strong>@octo</strong>, to be linked to the wardby account <strong>alice</strong>.</p>" +
        "<p>Give your MCP client this code (call <code>link_host_account</code> with <code>confirmationCode</code>):</p>",
    );
    expect(confirm).toContain("someone may be trying to use your GitHub account's access.</p>");
    vi.mocked(completeOAuthCallback).mockResolvedValueOnce({ kind: "invalid" });
    expect(await body("code=c&state=s")).toContain(
      "<p>This link is invalid or has expired. Start again from your MCP client with <code>link_host_account</code>.</p>",
    );
    vi.mocked(completeOAuthCallback).mockResolvedValueOnce({ kind: "failed" });
    expect(await body("code=c&state=s")).toContain(
      "<p>GitHub did not complete the sign-in. Start again from your MCP client.</p>",
    );
    expect(await body("error=access_denied")).toContain(
      "<p>You cancelled on GitHub. Nothing was linked; you can close this page.</p>",
    );
    expect(await body("error=other")).toContain(
      "<p>GitHub did not authorize the link. Start again from your MCP client.</p>",
    );
  });

  it("passes the iss parameter (RFC 9207) through, and none when it is absent", async () => {
    vi.mocked(completeOAuthCallback).mockClear();
    vi.mocked(completeOAuthCallback).mockResolvedValue({ kind: "invalid" });
    const { res } = fakeRes();
    await handleOAuthCallback(url("code=c&state=s&iss=https%3A%2F%2Fas.example"), res, deps);
    expect(vi.mocked(completeOAuthCallback).mock.calls[0][0]).toMatchObject({ iss: "https://as.example" });
    await handleOAuthCallback(url("code=c&state=s"), fakeRes().res, deps);
    expect(vi.mocked(completeOAuthCallback).mock.calls[1][0].iss).toBeUndefined();
  });

  it("answers not valid for an over-long iss without completing the link", async () => {
    vi.mocked(completeOAuthCallback).mockClear();
    const { res, out } = fakeRes();
    await handleOAuthCallback(url(`code=c&state=s&iss=${"a".repeat(2049)}`), res, deps);
    expect(out.status).toBe(400);
    expect(completeOAuthCallback).not.toHaveBeenCalled();
  });
});
