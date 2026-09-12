import { describe, expect, it } from "vitest";
import type { Datastore, DatastoreValue } from "../providers/datastore/types.js";
import { runInSandbox } from "./run-in-sandbox.js";

function fakeDatastore(): Datastore {
  const store = new Map<string, DatastoreValue>();
  const scopedKey = (agentId: string, key: string) => `${agentId}:${key}`;
  return {
    async get(agentId, key) {
      return store.get(scopedKey(agentId, key));
    },
    async set(agentId, key, value) {
      store.set(scopedKey(agentId, key), value);
    },
    async delete(agentId, key) {
      store.delete(scopedKey(agentId, key));
    },
    async list(agentId, prefix) {
      const p = `${agentId}:${prefix ?? ""}`;
      return [...store.keys()]
        .filter((k) => k.startsWith(p))
        .map((k) => k.slice(agentId.length + 1))
        .sort();
    },
    async getShared() {
      return undefined;
    },
    async setShared() {},
    async deleteShared() {},
    async listShared() {
      return [];
    },
  };
}

const FAST_LIMITS = { wallTimeLimitMs: 300 };

describe("runInSandbox", () => {
  it("runs a tool body and returns its JSON-serializable result", async () => {
    const result = await runInSandbox({
      code: "return { doubled: params.n * 2 };",
      params: { n: 21 },
      agentId: "a1",
      datastore: fakeDatastore(),
      toolName: "double",
    });
    expect(result).toEqual({ ok: true, value: { doubled: 42 } });
  });

  it("yields a structured error result for a throwing tool, without crashing", async () => {
    const result = await runInSandbox({
      code: "throw new Error('tool blew up');",
      params: {},
      agentId: "a1",
      datastore: fakeDatastore(),
      toolName: "boom",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorKind).toBe("thrown");
      expect(result.errorMessage).toMatch(/tool blew up/);
    }
  });

  it("trips the CPU/instruction cap on an infinite loop", async () => {
    const result = await runInSandbox({
      code: "while (true) { /* spin */ }",
      params: {},
      agentId: "a1",
      datastore: fakeDatastore(),
      toolName: "spinner",
      limits: { maxInterruptChecks: 10_000, wallTimeLimitMs: 5_000 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorKind).toBe("cpu");
  });

  it("trips the memory cap on unbounded allocation", async () => {
    const result = await runInSandbox({
      code: "let a = []; while (true) { a.push(new Array(10000).fill('x')); }",
      params: {},
      agentId: "a1",
      datastore: fakeDatastore(),
      toolName: "hog",
      limits: { memoryLimitBytes: 256 * 1024, wallTimeLimitMs: 5_000, maxInterruptChecks: 50_000_000 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorKind).toBe("memory");
  });

  it("trips the wall-time limit on a call that hangs awaiting a host promise", async () => {
    const result = await runInSandbox({
      code: "await new Promise(() => {}); return 'never';",
      params: {},
      agentId: "a1",
      datastore: fakeDatastore(),
      toolName: "hangs",
      limits: FAST_LIMITS,
    });
    expect(result).toEqual({
      ok: false,
      errorKind: "timeout",
      errorMessage: expect.stringContaining("wall-time limit"),
    });
  });

  it("fails cleanly on a non-JSON-serializable return value", async () => {
    const result = await runInSandbox({
      code: "const a = {}; a.self = a; return a;",
      params: {},
      agentId: "a1",
      datastore: fakeDatastore(),
      toolName: "circular",
      limits: FAST_LIMITS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorKind).toBe("non_serializable");
  });

  it("has no access to host globals (process, require, filesystem)", async () => {
    const result = await runInSandbox({
      code: `return {
        hasProcess: typeof process !== "undefined",
        hasRequire: typeof require !== "undefined",
        hasFs: typeof __dirname !== "undefined",
      };`,
      params: {},
      agentId: "a1",
      datastore: fakeDatastore(),
      toolName: "probe",
      limits: FAST_LIMITS,
    });
    expect(result).toEqual({
      ok: true,
      value: { hasProcess: false, hasRequire: false, hasFs: false },
    });
  });

  it("round-trips datastore.set/get, scoped per agent", async () => {
    const datastore = fakeDatastore();
    const setResult = await runInSandbox({
      code: "await datastore.set('greeting', 'hi'); return 'ok';",
      params: {},
      agentId: "agent-a",
      datastore,
      toolName: "setter",
      limits: FAST_LIMITS,
    });
    expect(setResult).toEqual({ ok: true, value: "ok" });

    const getFromA = await runInSandbox({
      code: "return await datastore.get('greeting');",
      params: {},
      agentId: "agent-a",
      datastore,
      toolName: "getter",
      limits: FAST_LIMITS,
    });
    expect(getFromA).toEqual({ ok: true, value: "hi" });

    const getFromB = await runInSandbox({
      code: "return await datastore.get('greeting');",
      params: {},
      agentId: "agent-b",
      datastore,
      toolName: "getter",
      limits: FAST_LIMITS,
    });
    expect(getFromB).toEqual({ ok: true, value: null });
  });

  it("passes a pii option from sandboxed code through to the host datastore.set", async () => {
    const setCalls: unknown[] = [];
    const datastore: Datastore = {
      ...fakeDatastore(),
      async set(agentId, key, value, opts) {
        setCalls.push(opts);
      },
    };
    const result = await runInSandbox({
      code: "await datastore.set('ssn', '123-45-6789', { pii: true }); return 'ok';",
      params: {},
      agentId: "agent-a",
      datastore,
      toolName: "pii-setter",
      limits: FAST_LIMITS,
    });
    expect(result).toEqual({ ok: true, value: "ok" });
    expect(setCalls).toEqual([{ pii: true }]);
  });

  it("supports fetch, JSON, and console without crossing into host state", async () => {
    const result = await runInSandbox({
      code: `
        console.log("probing");
        return {
          hasJSON: typeof JSON.stringify === "function",
          hasFetch: typeof fetch === "function",
          uuid: typeof (await crypto.randomUUID()) === "string",
        };
      `,
      params: {},
      agentId: "a1",
      datastore: fakeDatastore(),
      toolName: "probe2",
      limits: FAST_LIMITS,
    });
    expect(result).toEqual({
      ok: true,
      value: { hasJSON: true, hasFetch: true, uuid: true },
    });
  });

  it("blocks a tool's fetch to cloud instance metadata, failing cleanly (no real request made)", async () => {
    const result = await runInSandbox({
      code: `
        try {
          await fetch("http://169.254.169.254/latest/meta-data/iam/security-credentials/");
          return "no error thrown (unexpected)";
        } catch (e) {
          return "caught: " + e.message;
        }
      `,
      params: {},
      agentId: "a1",
      datastore: fakeDatastore(),
      toolName: "ssrf-probe",
      limits: FAST_LIMITS,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatch(/caught:.*blocked/);
    }
  });

  it("blocks a tool's fetch to loopback (the host's own services)", async () => {
    const result = await runInSandbox({
      code: `
        try {
          await fetch("http://127.0.0.1:5432/");
          return "no error thrown (unexpected)";
        } catch (e) {
          return "caught: " + e.message;
        }
      `,
      params: {},
      agentId: "a1",
      datastore: fakeDatastore(),
      toolName: "ssrf-probe-2",
      limits: FAST_LIMITS,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatch(/caught:.*blocked/);
    }
  });

  it("URLSearchParams does not truncate a value containing '=' (e.g. a base64/JWT token)", async () => {
    const result = await runInSandbox({
      code: `
        const p = new URLSearchParams("token=abc.def==&plain=1");
        return { token: p.get("token"), plain: p.get("plain") };
      `,
      params: {},
      agentId: "a1",
      datastore: fakeDatastore(),
      toolName: "urlsearchparams-probe",
      limits: FAST_LIMITS,
    });
    expect(result).toEqual({ ok: true, value: { token: "abc.def==", plain: "1" } });
  });

  it("sendEmail placeholder throws a clear 'not implemented' error when called", async () => {
    const result = await runInSandbox({
      code: "return await sendEmail({ to: 'x@example.com' });",
      params: {},
      agentId: "a1",
      datastore: fakeDatastore(),
      toolName: "email-test",
      limits: FAST_LIMITS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorMessage).toMatch(/sendEmail is not implemented in this build/);
    }
  });

  it("getInboundEmail placeholder throws a clear 'not implemented' error when called", async () => {
    const result = await runInSandbox({
      code: "return await getInboundEmail();",
      params: {},
      agentId: "a1",
      datastore: fakeDatastore(),
      toolName: "email-test-2",
      limits: FAST_LIMITS,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorMessage).toMatch(/getInboundEmail is not implemented in this build/);
    }
  });
});
