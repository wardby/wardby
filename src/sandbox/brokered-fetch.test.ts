import { describe, expect, it } from "vitest";
import type { SecretEntry, SecretsAccessor } from "../core/secrets.js";
import { brokeredFetch } from "./brokered-fetch.js";
import type { safeFetch } from "./safe-fetch.js";

type Fetched = { url: string; init: { headers?: Record<string, string>; body?: string } };

const bearer = {
  placement: { kind: "header", name: "Authorization", format: "Bearer {value}" },
  hosts: ["oauth.fake.test"],
};
const oauthEntry = (token: string, redact: string[]): SecretEntry =>
  ({ value: token, broker: bearer, oauth: { redact } }) as unknown as SecretEntry;

function respond(status: number, body = "{}") {
  return { status, headers: {}, url: "https://oauth.fake.test/mcp", bodyBase64: Buffer.from(body).toString("base64") };
}

function setup(statuses: number[], bodies: string[] = []) {
  const calls: Fetched[] = [];
  const fetchImpl = (async (url: string, init: Fetched["init"]) => {
    calls.push({ url, init });
    const i = calls.length - 1;
    return respond(statuses[i] ?? 200, bodies[i]);
  }) as unknown as typeof safeFetch;
  const console_: string[] = [];
  return { calls, fetchImpl, console_, redactFromConsole: (v: string) => console_.push(v) };
}

const base = { url: "https://oauth.fake.test/mcp", secretNames: ["s"], policy: {} as never };

describe("brokeredFetch 401 retry", () => {
  it("refreshes once on a 401 and resends the same body with the new token", async () => {
    const t = setup([401, 200]);
    const refreshCalls: Array<[string, string]> = [];
    const secrets = {
      resolve: async () => oauthEntry("old-token-1", ["old-token-1", "old-refresh-1"]),
      refresh: async (name: string, used: string) => {
        refreshCalls.push([name, used]);
        return oauthEntry("new-token-2", ["new-token-2", "new-refresh-2"]);
      },
    } as unknown as SecretsAccessor;
    const out = (await brokeredFetch({
      ...base,
      init: { method: "POST", body: '{"a":1}' },
      secrets,
      fetchImpl: t.fetchImpl,
      redactFromConsole: t.redactFromConsole,
    })) as { status: number };
    expect(out.status).toBe(200);
    expect(refreshCalls).toEqual([["s", "old-token-1"]]);
    expect(t.calls).toHaveLength(2);
    expect(t.calls[0].init.headers?.authorization).toBe("Bearer old-token-1");
    expect(t.calls[1].init.headers?.authorization).toBe("Bearer new-token-2");
    expect(t.calls[1].init.body).toBe('{"a":1}');
  });

  it("registers the fresh values for console redaction before the retry is sent", async () => {
    const t = setup([401, 200]);
    const seenAtRetry: string[][] = [];
    const inner = t.fetchImpl;
    const fetchImpl = (async (...args: Parameters<typeof safeFetch>) => {
      if (t.calls.length === 1) seenAtRetry.push([...t.console_]);
      return (inner as (...a: unknown[]) => unknown)(...args);
    }) as unknown as typeof safeFetch;
    const secrets = {
      resolve: async () => oauthEntry("old-token-1", ["old-token-1"]),
      refresh: async () => oauthEntry("new-token-2", ["new-token-2", "new-refresh-2"]),
    } as unknown as SecretsAccessor;
    await brokeredFetch({ ...base, init: {}, secrets, fetchImpl, redactFromConsole: t.redactFromConsole });
    expect(seenAtRetry[0]).toEqual(expect.arrayContaining(["new-token-2", "new-refresh-2"]));
  });

  it("returns the second 401 and makes no third request", async () => {
    const t = setup([401, 401, 200]);
    const secrets = {
      resolve: async () => oauthEntry("old-token-1", ["old-token-1"]),
      refresh: async () => oauthEntry("new-token-2", ["new-token-2"]),
    } as unknown as SecretsAccessor;
    const out = (await brokeredFetch({
      ...base,
      init: {},
      secrets,
      fetchImpl: t.fetchImpl,
      redactFromConsole: t.redactFromConsole,
    })) as { status: number };
    expect(out.status).toBe(401);
    expect(t.calls).toHaveLength(2);
  });

  it("does not retry a non-OAuth secret on a 401", async () => {
    const t = setup([401, 200]);
    let refreshed = false;
    const secrets = {
      resolve: async () => ({ value: "plain-token-1", broker: bearer }),
      refresh: async () => {
        refreshed = true;
        return undefined;
      },
    } as unknown as SecretsAccessor;
    const out = (await brokeredFetch({
      ...base,
      init: {},
      secrets,
      fetchImpl: t.fetchImpl,
      redactFromConsole: t.redactFromConsole,
    })) as { status: number };
    expect(out.status).toBe(401);
    expect(refreshed).toBe(false);
    expect(t.calls).toHaveLength(1);
  });

  it("scrubs the retried response against both the old and the new values", async () => {
    const t = setup([401, 200], ["", "echo old-token-1 new-token-2 new-refresh-2"]);
    const secrets = {
      resolve: async () => oauthEntry("old-token-1", ["old-token-1"]),
      refresh: async () => oauthEntry("new-token-2", ["new-token-2", "new-refresh-2"]),
    } as unknown as SecretsAccessor;
    const out = (await brokeredFetch({
      ...base,
      init: {},
      secrets,
      fetchImpl: t.fetchImpl,
      redactFromConsole: t.redactFromConsole,
    })) as { bodyBase64: string };
    const text = Buffer.from(out.bodyBase64, "base64").toString();
    for (const v of ["old-token-1", "new-token-2", "new-refresh-2"]) expect(text).not.toContain(v);
  });

  it("surfaces a fixed refresh error instead of the 401", async () => {
    const t = setup([401, 200]);
    const secrets = {
      resolve: async () => oauthEntry("old-token-1", ["old-token-1"]),
      refresh: async () => {
        throw new Error("secret_reauth_required: reauthorize s");
      },
    } as unknown as SecretsAccessor;
    await expect(
      brokeredFetch({ ...base, init: {}, secrets, fetchImpl: t.fetchImpl, redactFromConsole: t.redactFromConsole }),
    ).rejects.toThrow("secret_reauth_required");
    expect(t.calls).toHaveLength(1);
  });
});

describe("brokeredFetch stop signal", () => {
  it("passes the policy's signal to resolve and to the 401 refresh", async () => {
    const t = setup([401, 200]);
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const secrets = {
      resolve: async (_name: string, opts?: { signal?: AbortSignal }) => {
        seen.push(opts?.signal);
        return oauthEntry("old-token-1", ["old-token-1"]);
      },
      refresh: async (_name: string, _used: string, opts?: { signal?: AbortSignal }) => {
        seen.push(opts?.signal);
        return oauthEntry("new-token-2", ["new-token-2"]);
      },
    } as unknown as SecretsAccessor;
    await brokeredFetch({
      ...base,
      policy: { signal: controller.signal },
      init: {},
      secrets,
      fetchImpl: t.fetchImpl,
      redactFromConsole: t.redactFromConsole,
    });
    expect(seen).toEqual([controller.signal, controller.signal]);
  });
});
