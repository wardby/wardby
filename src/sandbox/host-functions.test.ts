import { describe, expect, it } from "vitest";
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
