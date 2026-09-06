import { describe, expect, it, vi } from "vitest";
import type { Datastore, DatastoreValue } from "../providers/datastore/types.js";
import type { SecretsAccessor } from "../core/secrets.js";
import { runInSandbox } from "./run-in-sandbox.js";

function fakeDatastore(): Datastore {
  const store = new Map<string, DatastoreValue>();
  return {
    async get(agentId, key) {
      return store.get(`${agentId}:${key}`);
    },
    async set(agentId, key, value) {
      store.set(`${agentId}:${key}`, value);
    },
    async delete(agentId, key) {
      store.delete(`${agentId}:${key}`);
    },
    async list(agentId, prefix) {
      const p = `${agentId}:${prefix ?? ""}`;
      return [...store.keys()].filter((k) => k.startsWith(p)).map((k) => k.slice(agentId.length + 1));
    },
  };
}

function fakeSecrets(values: Record<string, string>): SecretsAccessor {
  return {
    async get(name) {
      return values[name];
    },
  };
}

describe("secrets.get sandbox host function", () => {
  it.each(["-1", "1.5", "Infinity", "NaN", "65537"])("rejects invalid random byte length %s", async (length) => {
    const result = await runInSandbox({ code: `return await __bridge_randomBytes(JSON.stringify([${length}]));`, params: {}, agentId: "a", datastore: fakeDatastore(), toolName: "limits" });
    expect(result).toMatchObject({ ok: false, errorMessage: expect.stringContaining("random_bytes_limit") });
  });
  it.each(["return await parseHTML('x'.repeat(262145));", "return await parseCSV('x'.repeat(262145));", "return await parseXML('<!DOCTYPE x><x/>');", "return await parseXML('<x/>', {processEntities:true});", "return await __bridge_randomBytes({evil:'x'});", "return await datastore.set('key', 'x'.repeat(1048577));"])("caps parser and bridge input %s", async (code) => {
    const result = await runInSandbox({ code, params: {}, agentId: "a", datastore: fakeDatastore(), toolName: "limits" });
    expect(result).toMatchObject({ ok: false });
  });
  it("clears successful invocation wall timers", async () => {
    await runInSandbox({ code: "return 1", params: {}, agentId: "a", datastore: fakeDatastore(), toolName: "warmup" });
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 5; i++) await runInSandbox({ code: "return 1", params: {}, agentId: "a", datastore: fakeDatastore(), toolName: "timer" });
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("bounds HTML link extraction before constructing an amplified result", async () => {
    const result = await runInSandbox({ code: "return await parseHTML('<a href=\"/\">text</a>'.repeat(1001));", params: {}, agentId: "a", datastore: fakeDatastore(), toolName: "limits" });
    expect(result).toMatchObject({ ok: false, errorMessage: expect.stringContaining("html_link_limit") });
  });
  it("returns the plaintext for an attached secret", async () => {
    const result = await runInSandbox({
      code: "return await secrets.get('API_KEY');",
      params: {},
      agentId: "a1",
      datastore: fakeDatastore(),
      secrets: fakeSecrets({ API_KEY: "sk-live-abc123" }),
      toolName: "read-secret",
    });
    expect(result).toEqual({ ok: true, value: "sk-live-abc123" });
  });

  it("returns undefined for an unattached name", async () => {
    const result = await runInSandbox({
      code: "const v = await secrets.get('NOT_ATTACHED'); return v === undefined ? 'undefined' : v;",
      params: {},
      agentId: "a1",
      datastore: fakeDatastore(),
      secrets: fakeSecrets({ API_KEY: "sk-live-abc123" }),
      toolName: "read-secret",
    });
    expect(result).toEqual({ ok: true, value: "undefined" });
  });

  it("returns undefined when no secrets accessor is provided at all (e.g. dry_run_tool)", async () => {
    const result = await runInSandbox({
      code: "const v = await secrets.get('API_KEY'); return v === undefined ? 'undefined' : v;",
      params: {},
      agentId: "a1",
      datastore: fakeDatastore(),
      toolName: "read-secret",
    });
    expect(result).toEqual({ ok: true, value: "undefined" });
  });

  it("the secret value never appears in captured console output", async () => {
    const logs: unknown[][] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args);
    try {
      await runInSandbox({
        code: "const v = await secrets.get('API_KEY'); console.log('got a secret, length', v.length); return 'ok';",
        params: {},
        agentId: "a1",
        datastore: fakeDatastore(),
        secrets: fakeSecrets({ API_KEY: "sk-live-abc123" }),
        toolName: "read-secret",
      });
    } finally {
      console.log = originalLog;
    }
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain("sk-live-abc123");
  });
});
