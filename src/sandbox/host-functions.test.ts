import { SANDBOX_PRELUDE } from "./prelude.js";
import { LOCAL_BRIDGE_NAMES, PRIVILEGED_BRIDGE_NAMES } from "./host-functions.js";
import { describe, expect, it, vi } from "vitest";
import type { Datastore, DatastoreValue } from "../providers/datastore/types.js";
import type { SecretsAccessor } from "../core/secrets.js";
import type { SharedDatastoreAccessor } from "../core/datastores.js";
import { runInSandbox } from "./run-in-sandbox.js";
import type { SecretBrokerConfig } from "../core/secret-broker-config.js";
import type { safeFetch } from "./safe-fetch.js";

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

function fakeSharedDatastore(): SharedDatastoreAccessor {
  const store = new Map<string, string>();
  return {
    async get(boundName, key) {
      return store.get(`${boundName}:${key}`);
    },
    async set(boundName, key, value) {
      store.set(`${boundName}:${key}`, value as string);
    },
    async delete(boundName, key) {
      store.delete(`${boundName}:${key}`);
    },
    async list(boundName, prefix) {
      const p = `${boundName}:${prefix ?? ""}`;
      return [...store.keys()].filter((k) => k.startsWith(p)).map((k) => k.slice(boundName.length + 1));
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

const FAST_LIMITS = { wallTimeLimitMs: 300 };

describe("secrets.get sandbox host function", () => {
  it.each(["-1", "1.5", "Infinity", "NaN", "65537"])("rejects invalid random byte length %s", async (length) => {
    const result = await runInSandbox({
      code: `return await __bridge_randomBytes(JSON.stringify([${length}]));`,
      params: {},
      agentId: "a",
      datastore: fakeDatastore(),
      sharedDatastore: fakeSharedDatastore(),
      toolName: "limits",
    });
    expect(result).toMatchObject({ ok: false, errorMessage: expect.stringContaining("random_bytes_limit") });
  });
  it.each([
    "return await parseHTML('x'.repeat(262145));",
    "return await parseCSV('x'.repeat(262145));",
    "return await parseXML('<!DOCTYPE x><x/>');",
    "return await parseXML('<x/>', {processEntities:true});",
    "return await __bridge_randomBytes({evil:'x'});",
    "return await datastore.set('key', 'x'.repeat(1048577));",
  ])("caps parser and bridge input %s", async (code) => {
    const result = await runInSandbox({
      code,
      params: {},
      agentId: "a",
      datastore: fakeDatastore(),
      sharedDatastore: fakeSharedDatastore(),
      toolName: "limits",
    });
    expect(result).toMatchObject({ ok: false });
  });
  it("clears successful invocation wall timers", async () => {
    await runInSandbox({
      code: "return 1",
      params: {},
      agentId: "a",
      datastore: fakeDatastore(),
      sharedDatastore: fakeSharedDatastore(),
      toolName: "warmup",
    });
    vi.useFakeTimers();
    try {
      for (let i = 0; i < 5; i++)
        await runInSandbox({
          code: "return 1",
          params: {},
          agentId: "a",
          datastore: fakeDatastore(),
          sharedDatastore: fakeSharedDatastore(),
          toolName: "timer",
        });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("bounds HTML link extraction before constructing an amplified result", async () => {
    const result = await runInSandbox({
      code: "return await parseHTML('<a href=\"/\">text</a>'.repeat(1001));",
      params: {},
      agentId: "a",
      datastore: fakeDatastore(),
      sharedDatastore: fakeSharedDatastore(),
      toolName: "limits",
    });
    expect(result).toMatchObject({ ok: false, errorMessage: expect.stringContaining("html_link_limit") });
  });
  it("parses valid CSV end-to-end through the worker pool", async () => {
    const result = await runInSandbox({
      code: "return await parseCSV('a,b\\n1,2');",
      params: {},
      agentId: "a",
      datastore: fakeDatastore(),
      sharedDatastore: fakeSharedDatastore(),
      toolName: "csv-smoke",
    });
    expect(result).toMatchObject({ ok: true, value: { data: [{ a: "1", b: "2" }] } });
  });
  it("parses valid XML end-to-end through the worker pool", async () => {
    const result = await runInSandbox({
      code: "return await parseXML('<x>hi</x>');",
      params: {},
      agentId: "a",
      datastore: fakeDatastore(),
      sharedDatastore: fakeSharedDatastore(),
      toolName: "xml-smoke",
    });
    expect(result).toMatchObject({ ok: true, value: { x: "hi" } });
  });
  it("parses valid HTML end-to-end through the worker pool", async () => {
    const result = await runInSandbox({
      code: "return await parseHTML('<title>T</title><a href=\"/x\">L</a>');",
      params: {},
      agentId: "a",
      datastore: fakeDatastore(),
      sharedDatastore: fakeSharedDatastore(),
      toolName: "html-smoke",
    });
    expect(result).toMatchObject({ ok: true, value: { title: "T", links: [{ href: "/x", text: "L" }] } });
  });
  it("returns the plaintext for an attached secret", async () => {
    const result = await runInSandbox({
      code: "return await secrets.get('API_KEY');",
      params: {},
      agentId: "a1",
      datastore: fakeDatastore(),
      sharedDatastore: fakeSharedDatastore(),
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
      sharedDatastore: fakeSharedDatastore(),
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
      sharedDatastore: fakeSharedDatastore(),
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
        sharedDatastore: fakeSharedDatastore(),
        secrets: fakeSecrets({ API_KEY: "sk-live-abc123" }),
        toolName: "read-secret",
      });
    } finally {
      console.log = originalLog;
    }
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain("sk-live-abc123");
  });

  function fakeLogger() {
    const calls: { level: string; args: unknown[] }[] = [];
    const record =
      (level: string) =>
      (...args: unknown[]) => {
        calls.push({ level, args });
      };
    const instance = { info: record("info"), warn: record("warn"), error: record("error"), child: () => instance };
    return { logger: instance as never, calls };
  }

  it("redacts a secret's actual value out of tool console output that logs it directly", async () => {
    const { logger, calls } = fakeLogger();
    await runInSandbox({
      code: "const v = await secrets.get('API_KEY'); console.log('the key is', v); return 'ok';",
      params: {},
      agentId: "a1",
      datastore: fakeDatastore(),
      sharedDatastore: fakeSharedDatastore(),
      secrets: fakeSecrets({ API_KEY: "sk-live-abc123" }),
      toolName: "read-secret",
      logger,
    });
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain("sk-live-abc123");
    expect(serialized).toContain("REDACTED");
  });

  it("redacts PII-shaped content a tool logs from fetched data, even though it was never a fetched secret", async () => {
    const { logger, calls } = fakeLogger();
    await runInSandbox({
      code: "console.log('found contact:', 'jane.doe@example.com'); return 'ok';",
      params: {},
      agentId: "a1",
      datastore: fakeDatastore(),
      sharedDatastore: fakeSharedDatastore(),
      toolName: "scrape",
      logger,
    });
    const serialized = JSON.stringify(calls);
    expect(serialized).not.toContain("jane.doe@example.com");
    expect(serialized).toContain("REDACTED_EMAIL");
  });
});

describe("__bridge_fetch host scoping", () => {
  it("blocks all outbound fetch when the tool has no declared allowedFetchHosts (deny by default)", async () => {
    const result = await runInSandbox({
      code: "return await fetch('http://8.8.8.8/');",
      params: {},
      agentId: "a1",
      datastore: fakeDatastore(),
      sharedDatastore: fakeSharedDatastore(),
      toolName: "fetcher",
    });
    expect(result).toMatchObject({ ok: false, errorMessage: expect.stringContaining("fetch_destination_blocked") });
  });

  it("still enforces SSRF protection against private addresses even with the wildcard host declared", async () => {
    const result = await runInSandbox({
      code: "return await fetch('http://169.254.169.254/');",
      params: {},
      agentId: "a1",
      datastore: fakeDatastore(),
      sharedDatastore: fakeSharedDatastore(),
      toolName: "fetcher",
      allowedFetchHosts: ["*"],
    });
    expect(result).toMatchObject({ ok: false, errorMessage: expect.stringContaining("fetch_destination_blocked") });
  });

  it("restricts fetch to exactly the tool's declared host allowlist", async () => {
    const result = await runInSandbox({
      code: "return await fetch('http://8.8.8.8/');",
      params: {},
      agentId: "a1",
      datastore: fakeDatastore(),
      sharedDatastore: fakeSharedDatastore(),
      toolName: "fetcher",
      allowedFetchHosts: ["example.com"],
    });
    expect(result).toMatchObject({ ok: false, errorMessage: expect.stringContaining("fetch_destination_blocked") });
  });
});

describe("__bridge_fetch: a tool's own allowedFetchHosts cannot open private/metadata destinations (S2-1)", () => {
  it.each([
    ["http://169.254.169.254/computeMetadata/v1/", "169.254.169.254"],
    ["http://127.0.0.1:5432/", "127.0.0.1"],
    ["http://[::1]/", "[::1]"],
    ["http://2852039166/", "2852039166"],
  ])("blocks %s even though the tool lists %s", async (url, host) => {
    const result = await runInSandbox({
      code: `return await fetch(${JSON.stringify(url)}, { headers: { "Metadata-Flavor": "Google" } });`,
      params: {},
      agentId: "a1",
      datastore: fakeDatastore(),
      sharedDatastore: fakeSharedDatastore(),
      toolName: "fetcher",
      allowedFetchHosts: [host],
    });
    expect(result).toMatchObject({ ok: false, errorMessage: expect.stringContaining("fetch_destination_blocked") });
  });
});

describe("sharedDatastore sandbox host functions", () => {
  it("sharedDatastore bridge functions round-trip through a bound name", async () => {
    const sharedDatastore = fakeSharedDatastore();
    const result = await runInSandbox({
      code: `
        await sharedDatastore.set('kb', 'k1', 'v1');
        const value = await sharedDatastore.get('kb', 'k1');
        await sharedDatastore.set('kb', 'k2', 'v2');
        const listed = await sharedDatastore.list('kb');
        await sharedDatastore.delete('kb', 'k1');
        const afterDelete = await sharedDatastore.get('kb', 'k1');
        return { value, listed, afterDelete };
      `,
      params: {},
      agentId: "agent-1",
      datastore: fakeDatastore(),
      sharedDatastore,
      toolName: "shared-roundtrip",
      limits: FAST_LIMITS,
    });
    expect(result).toEqual({ ok: true, value: { value: "v1", listed: ["k1", "k2"], afterDelete: null } });
  });
});

describe("bridge classification", () => {
  it("classifies every bridge the prelude calls exactly once, as privileged or local", () => {
    const called = new Set([...SANDBOX_PRELUDE.matchAll(/__bridge_[A-Za-z]+/g)].map((m) => m[0]));
    const privileged = new Set<string>(PRIVILEGED_BRIDGE_NAMES);
    const local = new Set<string>(LOCAL_BRIDGE_NAMES);
    for (const name of called) expect(privileged.has(name) !== local.has(name)).toBe(true);
    expect([...privileged, ...local].sort()).toEqual([...called].sort());
  });
});

function brokeredSecrets(
  entries: Record<string, { value: string; broker: SecretBrokerConfig | null }>,
): SecretsAccessor {
  return {
    async get(name) {
      const e = entries[name];
      if (e?.broker) throw new Error("secret_brokered: this secret is brokered");
      return e?.value;
    },
    async resolve(name) {
      return entries[name];
    },
  };
}

const GH = {
  value: "ghp_secretvalue",
  broker: {
    hosts: ["api.github.com"],
    placement: { kind: "header", name: "Authorization", format: "Bearer {value}" },
  } as SecretBrokerConfig,
};

function echoFetch() {
  const calls: { url: string; init: unknown; options: unknown }[] = [];
  const impl = (async (url, init, options) => {
    calls.push({ url, init, options });
    const auth = init?.headers?.authorization;
    const echoed = JSON.stringify({ sawAuth: auth ?? null });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      url,
      headers: { "x-echo": String(auth) },
      bodyBase64: Buffer.from(echoed).toString("base64"),
    };
  }) as typeof safeFetch;
  return { impl, calls };
}

function captureLogger() {
  const calls: { level: string; args: unknown[] }[] = [];
  const record =
    (level: string) =>
    (...args: unknown[]) => {
      calls.push({ level, args });
    };
  const instance = { info: record("info"), warn: record("warn"), error: record("error"), child: () => instance };
  return { logger: instance as never, calls };
}

describe("brokered secrets through fetch", () => {
  const base = (code: string, fetchImpl: typeof safeFetch, secrets: SecretsAccessor) => ({
    code,
    params: {},
    limits: FAST_LIMITS,
    agentId: "a1",
    datastore: fakeDatastore(),
    sharedDatastore: fakeSharedDatastore(),
    toolName: "gh",
    allowedFetchHosts: ["api.github.com"],
    secrets,
    fetchImpl,
  });

  it("places the value for the upstream and scrubs it from what the tool sees", async () => {
    const { impl, calls } = echoFetch();
    const result = await runInSandbox(
      base(
        "const r = await fetch('https://api.github.com/repos/o/r', { secrets: ['GH'] }); return { body: await r.text(), echo: r.headers.get('x-echo') };",
        impl,
        brokeredSecrets({ GH }),
      ),
    );
    expect(calls[0].init).toMatchObject({ headers: { authorization: "Bearer ghp_secretvalue" } });
    expect(calls[0].options).toMatchObject({ followRedirects: false });
    expect(JSON.stringify(result)).not.toContain("ghp_secretvalue");
    expect(result).toMatchObject({ ok: true, value: { echo: "Bearer [REDACTED]" } });
  });

  it("leaves a plain fetch (no secrets) on the normal path, redirects followed", async () => {
    const { impl, calls } = echoFetch();
    const result = await runInSandbox(
      base("const r = await fetch('https://api.github.com/x'); return r.status;", impl, brokeredSecrets({ GH })),
    );
    expect(result).toEqual({ ok: true, value: 200 });
    expect(calls[0].options).not.toHaveProperty("followRedirects");
  });

  it("denies a destination outside the secret's hosts", async () => {
    const { impl, calls } = echoFetch();
    const result = await runInSandbox(
      base("return await fetch('https://gist.github.com/', { secrets: ['GH'] });", impl, brokeredSecrets({ GH })),
    );
    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({
      ok: false,
      errorMessage: expect.stringContaining("secret_broker_destination_denied"),
    });
  });

  it("refuses secrets.get on a brokered secret", async () => {
    const result = await runInSandbox(
      base("return await secrets.get('GH');", echoFetch().impl, brokeredSecrets({ GH })),
    );
    expect(result).toMatchObject({ ok: false, errorMessage: expect.stringContaining("secret_brokered") });
  });

  it("refuses a readable or unattached secret in fetch secrets", async () => {
    const secrets = brokeredSecrets({ PLAIN: { value: "plain-value", broker: null } });
    for (const name of ["PLAIN", "MISSING"]) {
      const { impl, calls } = echoFetch();
      const result = await runInSandbox(
        base(`return await fetch('https://api.github.com/', { secrets: ['${name}'] });`, impl, secrets),
      );
      expect(calls).toHaveLength(0);
      expect(result).toMatchObject({ ok: false, errorMessage: expect.stringContaining("secret_not_brokered") });
    }
  });

  it("refuses brokering when the accessor cannot resolve (e.g. a dry run with no secrets)", async () => {
    const { impl, calls } = echoFetch();
    const result = await runInSandbox({
      ...base("return await fetch('https://api.github.com/', { secrets: ['GH'] });", impl, brokeredSecrets({ GH })),
      secrets: undefined,
    });
    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ ok: false, errorMessage: expect.stringContaining("secret_not_brokered") });
  });

  it("refuses more than 8 brokered secrets in one request", async () => {
    const { impl, calls } = echoFetch();
    const names = JSON.stringify(Array.from({ length: 9 }, () => "GH"));
    const result = await runInSandbox(
      base(`return await fetch('https://api.github.com/', { secrets: ${names} });`, impl, brokeredSecrets({ GH })),
    );
    expect(calls).toHaveLength(0);
    expect(result).toMatchObject({ ok: false, errorMessage: expect.stringContaining("secret_not_brokered") });
  });

  it("redacts a brokered value from console output", async () => {
    const { logger, calls } = captureLogger();
    const { impl } = echoFetch();
    await runInSandbox({
      ...base(
        "const r = await fetch('https://api.github.com/x', { secrets: ['GH'] }); console.log('v', atob(btoa('ghp_secretvalue'))); return 1;",
        impl,
        brokeredSecrets({ GH }),
      ),
      logger,
    });
    const serialized = JSON.stringify(calls);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("ghp_secretvalue");
  });

  it("redacts a brokered value from console output even when the fetch itself fails", async () => {
    const { logger, calls } = captureLogger();
    const failing = (async () => {
      throw new Error("fetch_failed");
    }) as typeof safeFetch;
    await runInSandbox({
      ...base(
        "try { await fetch('https://api.github.com/x', { secrets: ['GH'] }); } catch (e) { console.log('v', 'ghp_secretvalue'); } return 1;",
        failing,
        brokeredSecrets({ GH }),
      ),
      logger,
    });
    const serialized = JSON.stringify(calls);
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("ghp_secretvalue");
  });
});
