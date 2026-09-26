import type { ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../core/host-identity-links.js", () => ({ completeHostIdentityCallback: vi.fn() }));
import { completeHostIdentityCallback } from "../../core/host-identity-links.js";
import type { HostUserAuthorizer } from "../../providers/review-host/types.js";
import { handleHostUserCallback } from "./github-user-callback.js";

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

const deps = {
  db: {} as never,
  authorizer: { provider: "github" } as HostUserAuthorizer,
  redirectUri: "https://host/hosts/github/user-callback",
};
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
    vi.mocked(completeHostIdentityCallback).mockResolvedValueOnce({
      kind: "confirm",
      code: "ABCD-EFGH",
      login: "octo",
      subject: "<script>alert(1)</script>",
    });
    const { res, out } = fakeRes();
    await handleHostUserCallback(url("code=c0de&state=st4te"), res, deps);
    expect(out.status).toBe(200);
    expectSecurityHeaders(out.headers);
    expect(out.body).toContain("ABCD-EFGH");
    expect(out.body).toContain("@octo");
    expect(out.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out.body).not.toContain("<script>");
    expect(out.body).toMatch(/did not start this/i);
    expect(vi.mocked(completeHostIdentityCallback).mock.calls[0][0]).toMatchObject({
      state: "st4te",
      code: "c0de",
      redirectUri: deps.redirectUri,
    });
  });

  it("answers a generic 400 for an unknown, used, or expired state", async () => {
    vi.mocked(completeHostIdentityCallback).mockResolvedValueOnce({ kind: "invalid" });
    const { res, out } = fakeRes();
    await handleHostUserCallback(url("code=c&state=nope"), res, deps);
    expect(out.status).toBe(400);
    expectSecurityHeaders(out.headers);
    expect(out.body).toMatch(/invalid or has expired/);
  });

  it("reports a failed exchange without detail", async () => {
    vi.mocked(completeHostIdentityCallback).mockResolvedValueOnce({ kind: "failed" });
    const { res, out } = fakeRes();
    await handleHostUserCallback(url("code=c&state=s"), res, deps);
    expect(out.status).toBe(502);
  });

  it("shows a cancelled page when the user declines, without touching the link", async () => {
    vi.mocked(completeHostIdentityCallback).mockClear();
    const { res, out } = fakeRes();
    await handleHostUserCallback(url("error=access_denied&state=s"), res, deps);
    expect(out.status).toBe(200);
    expectSecurityHeaders(out.headers);
    expect(out.body).toMatch(/cancelled/i);
    const other = fakeRes();
    await handleHostUserCallback(url("error=<b>weird</b>&state=s"), other.res, deps);
    expect(other.out.status).toBe(400);
    expect(other.out.body).not.toContain("<b>");
    expect(completeHostIdentityCallback).not.toHaveBeenCalled();
  });
});
