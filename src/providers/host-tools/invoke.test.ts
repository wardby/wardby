import { describe, expect, it, vi } from "vitest";
import { invokeHostTool, type HostToolInvocation } from "./invoke.js";

const TOKEN = "fake-token-value-0123456789";
const PARAMS = { workspace: "acme", repo: "web", repository: "acme/web", number: 4 };
const API = "https://api.example.com/2.0/repositories/acme/web";

const logged = vi.hoisted(() => [] as string[]);
vi.mock("../../core/logger.js", () => {
  const make = (): Record<string, unknown> => {
    const at =
      () =>
      (...args: unknown[]) =>
        void logged.push(JSON.stringify(args));
    return { child: () => make(), trace: at(), debug: at(), info: at(), warn: at(), error: at(), fatal: at() };
  };
  return { logger: make() };
});

function response(body: unknown, status = 200) {
  return {
    ok: status < 300,
    status,
    statusText: "",
    url: API,
    headers: { "content-type": "application/json" },
    bodyBase64: Buffer.from(typeof body === "string" ? body : JSON.stringify(body)).toString("base64"),
  };
}

function input(code: string, overrides: Partial<HostToolInvocation> = {}): HostToolInvocation {
  return {
    provider: "bitbucket",
    operation: "getDiff",
    snapshot: {
      code,
      paramsZod: "z.object({ workspace: z.string(), repo: z.string(), repository: z.string(), number: z.number() })",
    },
    params: PARAMS,
    apiHosts: ["api.example.com"],
    pathPrefix: "/2.0/repositories/acme/web",
    credential: async () => ({
      value: TOKEN,
      broker: {
        hosts: ["api.example.com"],
        placement: { kind: "header", name: "Authorization", format: "Bearer {value}" },
      },
    }),
    fetchImpl: vi.fn(async () => response({ ok: true })),
    ...overrides,
  };
}

describe("invokeHostTool", () => {
  it("returns a valid result, placing the credential behind the host alias", async () => {
    const fetchImpl = vi.fn(async () => response("the diff"));
    const code = `const r = await fetch("${API}/pullrequests/4/diff", { secrets: ["host"] });
      return { diff: await r.text() };`;
    const result = await invokeHostTool(input(code, { fetchImpl: fetchImpl }));
    expect(result).toEqual({ ok: true, value: { diff: "the diff" } });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("scrubs the credential from what the tool reads back", async () => {
    const fetchImpl = vi.fn(async () => response(`echo ${TOKEN}`));
    const code = `const r = await fetch("${API}/x", { secrets: ["host"] }); return { diff: await r.text() };`;
    const result = await invokeHostTool(input(code, { fetchImpl: fetchImpl }));
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("refuses a result of the wrong shape with a fixed code", async () => {
    expect(await invokeHostTool(input(`return { diff: 4 };`))).toEqual({ ok: false, code: "host_tool_invalid_result" });
  });

  it("passes a decline as a fixed code, and refuses any other error text", async () => {
    expect(await invokeHostTool(input(`return { error: "not_found" };`))).toEqual({
      ok: false,
      code: "host_not_found",
    });
    expect(await invokeHostTool(input(`return { error: "secret text" };`))).toEqual({
      ok: false,
      code: "host_tool_invalid_result",
    });
  });

  it("drops a thrown message", async () => {
    const result = await invokeHostTool(input(`throw new Error("secret text from tool");`));
    expect(result).toEqual({ ok: false, code: "host_tool_failed" });
    expect(JSON.stringify(result)).not.toContain("secret text");
  });

  it("fails on a request outside the repository, even when the tool catches it", async () => {
    const fetchImpl = vi.fn(async () => response({}));
    const code = `try { await fetch("https://api.example.com/2.0/repositories/acme/other", { secrets: ["host"] }); } catch {}
      return { diff: "x" };`;
    expect(await invokeHostTool(input(code, { fetchImpl: fetchImpl }))).toEqual({
      ok: false,
      code: "host_tool_request_denied",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("guards a fetch with no secret the same way", async () => {
    const fetchImpl = vi.fn(async () => response({}));
    const code = `await fetch("https://evil.example.com/2.0/repositories/acme/web"); return { diff: "x" };`;
    expect((await invokeHostTool(input(code, { fetchImpl: fetchImpl }))).ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses any secret alias but host, and a write from a read operation", async () => {
    const other = `await fetch("${API}/x", { secrets: ["other"] }); return { diff: "x" };`;
    expect(await invokeHostTool(input(other))).toEqual({ ok: false, code: "host_tool_request_denied" });
    const post = `await fetch("${API}/x", { method: "POST", secrets: ["host"] }); return { diff: "x" };`;
    expect(await invokeHostTool(input(post))).toEqual({ ok: false, code: "host_tool_request_denied" });
  });

  it("caps fetches per call", async () => {
    const code = `for (let i = 0; i < 4; i++) await fetch("${API}/x", { secrets: ["host"] }); return { diff: "x" };`;
    expect(await invokeHostTool(input(code))).toEqual({ ok: false, code: "host_tool_request_denied" });
  });

  it("has no readable secret, datastore or shared datastore", async () => {
    for (const code of [
      `const v = await secrets.get("host"); return { diff: String(v) };`,
      `await datastore.set("k", "v"); return { diff: "x" };`,
      `await datastore.get("k"); return { diff: "x" };`,
    ]) {
      const result = await invokeHostTool(input(code));
      expect(result.ok, code).toBe(false);
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    }
  });

  it("drops console output", async () => {
    logged.length = 0;
    await invokeHostTool(input(`console.log("tool says ${TOKEN}"); return { diff: "x" };`));
    expect(logged.join("\n")).not.toContain("tool says");
  });

  it("reports no credential without running a request", async () => {
    const fetchImpl = vi.fn(async () => response({}));
    const code = `await fetch("${API}/x", { secrets: ["host"] }); return { diff: "x" };`;
    const result = await invokeHostTool(input(code, { credential: async () => undefined, fetchImpl: fetchImpl }));
    expect(result).toEqual({ ok: false, code: "host_tool_no_credential" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports no credential when the entry has no broker", async () => {
    const fetchImpl = vi.fn(async () => response({}));
    const code = `await fetch("${API}/x", { secrets: ["host"] }); return { diff: "x" };`;
    const credential = async () => ({ value: TOKEN, broker: null });
    const result = await invokeHostTool(input(code, { credential, fetchImpl: fetchImpl }));
    expect(result).toEqual({ ok: false, code: "host_tool_no_credential" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports no credential when the broker no longer allows an API host", async () => {
    const fetchImpl = vi.fn(async () => response({}));
    // The tool catches the failure, which must not turn it into a success.
    const code = `try { await fetch("${API}/x", { secrets: ["host"] }); } catch {} return { diff: "x" };`;
    const credential = async () => ({
      value: TOKEN,
      broker: { hosts: ["git.example.com"], placement: { kind: "header", name: "Authorization", format: "{value}" } },
    });
    const result = await invokeHostTool(input(code, { credential: credential as never, fetchImpl: fetchImpl }));
    expect(result).toEqual({ ok: false, code: "host_tool_no_credential" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a timeout", async () => {
    const result = await invokeHostTool(
      input(`while (true) {}`, { limits: { maxInterruptChecks: 2_000, wallTimeLimitMs: 500 } }),
    );
    expect(result).toEqual({ ok: false, code: "host_tool_timeout" });
  });

  it("refuses params the tool's schema rejects, without its message", async () => {
    const result = await invokeHostTool(input(`return { diff: "x" };`, { params: { nope: true } }));
    expect(result).toEqual({ ok: false, code: "host_tool_invalid_params" });
  });

  it("never follows a redirect, and the tool sees the 302", async () => {
    const fetchImpl = vi.fn(async () => response("", 302));
    const code = `const r = await fetch("${API}/x"); return { diff: String(r.status) };`;
    const result = await invokeHostTool(input(code, { fetchImpl: fetchImpl }));
    expect(result).toEqual({ ok: true, value: { diff: "302" } });
    const [, , options] = fetchImpl.mock.calls[0] as unknown as [string, unknown, { followRedirects: boolean }];
    expect(options.followRedirects).toBe(false);
  });

  it("sends nothing for a request with a header outside the allow-list", async () => {
    const fetchImpl = vi.fn(async () => response({}));
    const code = `await fetch("${API}/x", { headers: { "X-HTTP-Method-Override": "DELETE" } }); return { diff: "x" };`;
    expect(await invokeHostTool(input(code, { fetchImpl: fetchImpl }))).toEqual({
      ok: false,
      code: "host_tool_request_denied",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps a failing credential's text out of the result, even when the tool catches it", async () => {
    const fetchImpl = vi.fn(async () => response({}));
    const code = `let m = ""; try { await fetch("${API}/x", { secrets: ["host"] }); } catch (e) { m = String(e && e.message); }
      return { diff: m };`;
    const credential = async () => {
      throw new Error("fake-vault-detail-9876");
    };
    const result = await invokeHostTool(input(code, { credential, fetchImpl: fetchImpl }));
    expect(result).toEqual({ ok: false, code: "host_tool_no_credential" });
    expect(JSON.stringify(result)).not.toContain("fake-vault-detail");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
