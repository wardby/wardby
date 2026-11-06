import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Datastore } from "../providers/datastore/types.js";
import type { SharedDatastoreAccessor } from "../core/datastores.js";
import { loadToolMaxTimeoutMs } from "../config/tool-timeout.js";
import { runInSandbox, runToolCode } from "./run-in-sandbox.js";
import { createPrivilegedHost } from "./host-functions.js";
import { safeFetch, type SafeFetchOptions } from "./safe-fetch.js";
import {
  DEFAULT_TOOL_MAX_TIMEOUT_MS,
  DEFAULT_TOOL_TIMEOUT_MS,
  effectiveToolTimeoutMs,
  fetchTimeoutFor,
  TOOL_RUN_STOPPED_MESSAGE,
  toolTimeoutProblem,
} from "./tool-timeout.js";

const noDatastore = {} as Datastore;
const noSharedDatastore = {} as SharedDatastoreAccessor;
const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];

/** A connection that answers after `delayMs`, or fails as an aborted request would. */
function slowConnect(delayMs: number, seen?: { aborted: boolean }): NonNullable<SafeFetchOptions["connect"]> {
  return (_destination, _init, signal) =>
    new Promise<IncomingMessage>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          resolve(
            Object.assign(Readable.from([Buffer.from("account-created")]), {
              statusCode: 200,
              statusMessage: "OK",
              headers: { "content-type": "text/plain" },
            }) as unknown as IncomingMessage,
          ),
        delayMs,
      );
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          if (seen) seen.aborted = true;
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
}

/** The real safeFetch (its own timeout included), over a stubbed DNS answer and connection. */
function slowFetch(delayMs: number, seen?: { aborted: boolean }): typeof safeFetch {
  return (url, init, options) =>
    safeFetch(url, init, { ...options, resolve: publicDns, connect: slowConnect(delayMs, seen) });
}

const FETCH_TOOL = `
  const response = await fetch("https://api.example.com/accounts", { method: "POST" });
  return await response.text();
`;

function invocation(code: string, extra: Partial<Parameters<typeof runInSandbox>[0]> = {}) {
  return {
    code,
    params: {},
    agentId: "a1",
    datastore: noDatastore,
    sharedDatastore: noSharedDatastore,
    toolName: "slow",
    allowedFetchHosts: ["api.example.com"],
    ...extra,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("tool time limit helpers", () => {
  it("keeps 10 s for a tool without timeoutMs and caps a tool's own value at the current ceiling", () => {
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBe(10_000);
    expect(effectiveToolTimeoutMs(undefined, 300_000)).toBe(10_000);
    expect(effectiveToolTimeoutMs(null, 300_000)).toBe(10_000);
    expect(effectiveToolTimeoutMs(120_000, 300_000)).toBe(120_000);
    // Lowering the ceiling below a stored timeoutMs caps the run at the ceiling.
    expect(effectiveToolTimeoutMs(120_000, 60_000)).toBe(60_000);
  });

  it("lets each fetch run just past the tool's limit, so the wall-time error is the one seen", () => {
    expect(fetchTimeoutFor(10_000)).toBeGreaterThan(10_000);
    expect(fetchTimeoutFor(120_000)).toBeGreaterThan(120_000);
    expect(fetchTimeoutFor(120_000) - 120_000).toBeLessThanOrEqual(1_000);
  });

  it("names the ceiling when refusing a timeoutMs above it", () => {
    expect(toolTimeoutProblem(60_000, 300_000)).toBeUndefined();
    expect(toolTimeoutProblem(300_001, 300_000)).toContain("ceiling of 300000 ms (WARDBY_TOOL_MAX_TIMEOUT_MS)");
    expect(toolTimeoutProblem(999, 300_000)).toMatch(/at least 1000/);
    expect(toolTimeoutProblem(1500.5, 300_000)).toMatch(/whole number/);
    expect(toolTimeoutProblem("20000", 300_000)).toMatch(/whole number/);
  });

  it("reads WARDBY_TOOL_MAX_TIMEOUT_MS, defaulting to five minutes, never below the default limit", () => {
    expect(loadToolMaxTimeoutMs({})).toBe(DEFAULT_TOOL_MAX_TIMEOUT_MS);
    expect(DEFAULT_TOOL_MAX_TIMEOUT_MS).toBe(300_000);
    expect(loadToolMaxTimeoutMs({ WARDBY_TOOL_MAX_TIMEOUT_MS: " 600000 " })).toBe(600_000);
    for (const bad of ["9999", "abc", "-1", "1e6", "30000.5"]) {
      expect(() => loadToolMaxTimeoutMs({ WARDBY_TOOL_MAX_TIMEOUT_MS: bad })).toThrow(/WARDBY_TOOL_MAX_TIMEOUT_MS/);
    }
  });
});

describe("a tool's own time limit in the sandbox", () => {
  it("lets a tool with timeoutMs 20000 finish a 12 s fetch and a 10.5 s sleep; without it the fetch hits the wall time", async () => {
    const started = Date.now();
    const [withLimit, withoutLimit, longSleep, defaultSleep] = await Promise.all([
      runInSandbox(invocation(FETCH_TOOL, { timeoutMs: 20_000, fetchImpl: slowFetch(12_000) })),
      runInSandbox(invocation(FETCH_TOOL, { fetchImpl: slowFetch(12_000) })),
      runInSandbox(invocation("await __bridge_sleep(JSON.stringify([10500])); return 'slept';", { timeoutMs: 20_000 })),
      runInSandbox(invocation("await __bridge_sleep(JSON.stringify([10500])); return 'slept';")),
    ]);
    expect(withLimit).toEqual({ ok: true, value: "account-created" });
    expect(withoutLimit).toMatchObject({ ok: false, errorKind: "timeout" });
    expect(!withoutLimit.ok && withoutLimit.errorMessage).toContain("Exceeded the 10000ms wall-time limit");
    expect(!withoutLimit.ok && withoutLimit.errorMessage).toContain("timeoutMs");
    // sleep() is capped at the tool's limit: above the default only with timeoutMs.
    expect(longSleep).toEqual({ ok: true, value: "slept" });
    expect(defaultSleep).toMatchObject({ ok: false, errorKind: "thrown" });
    expect(!defaultSleep.ok && defaultSleep.errorMessage).toContain("sleep_limit");
    expect(Date.now() - started).toBeLessThan(18_000);
  }, 30_000);

  it("refuses a sleep longer than the tool's own limit", async () => {
    const result = await runInSandbox(
      invocation("await __bridge_sleep(JSON.stringify([2500])); return 'slept';", { timeoutMs: 2_000 }),
    );
    expect(result).toMatchObject({ ok: false, errorKind: "thrown" });
    expect(!result.ok && result.errorMessage).toContain("sleep_limit");
  });

  it("aborts a call in progress, and its fetch, when the run is stopped", async () => {
    const seen = { aborted: false };
    const stop = new AbortController();
    setTimeout(() => stop.abort(new Error("run_cancelled")), 200);
    const started = Date.now();
    const result = await runToolCode({
      code: FETCH_TOOL,
      params: {},
      limits: { wallTimeLimitMs: 20_000 },
      signal: stop.signal,
      privileged: (signal) =>
        createPrivilegedHost({
          agentId: "a1",
          datastore: noDatastore,
          sharedDatastore: noSharedDatastore,
          logTag: "slow",
          allowedFetchHosts: ["api.example.com"],
          fetchImpl: slowFetch(15_000, seen),
          fetchTimeoutMs: fetchTimeoutFor(20_000),
          signal,
        }),
    });
    expect(result).toEqual({ ok: false, errorKind: "cancelled", errorMessage: TOOL_RUN_STOPPED_MESSAGE });
    expect(seen.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("does not start a call whose run was already stopped", async () => {
    const stop = new AbortController();
    stop.abort();
    const privileged = vi.fn();
    const result = await runToolCode({ code: "return 1;", params: {}, signal: stop.signal, privileged });
    expect(result).toMatchObject({ ok: false, errorKind: "cancelled" });
    expect(privileged).not.toHaveBeenCalled();
  });
});
