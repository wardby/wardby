import { describe, expect, it, vi } from "vitest";
import type { Datastore } from "../providers/datastore/types.js";
import type { SharedDatastoreAccessor } from "./datastores.js";
import type { SecretsAccessor } from "./secrets.js";
import { fetchTimeoutFor } from "../sandbox/tool-timeout.js";
import { userToolHost } from "./user-tool-host.js";

const grants = {
  allowedSecrets: [],
  allowedDatastorePrefixes: [],
  allowedHosts: ["api.example.com"],
  allowedSharedDatastorePrefixes: {},
};

function fetchTimeoutOf(limitMs?: number): Promise<unknown> {
  const fetchImpl = vi.fn(async (_url: string, _init: unknown, policy: { timeoutMs?: number }) => ({
    status: 200,
    timeoutMs: policy.timeoutMs,
  }));
  const host = userToolHost({
    agentId: "agent-1",
    name: "t",
    tool: { ...grants, timeoutMs: 60_000 },
    ...(limitMs !== undefined ? { limitMs } : {}),
    signal: new AbortController().signal,
    datastore: {} as Datastore,
    sharedDatastore: {} as SharedDatastoreAccessor,
    secrets: {} as SecretsAccessor,
    fetchImpl: fetchImpl as never,
  });
  return host.__bridge_fetch(JSON.stringify(["https://api.example.com/x"]));
}

describe("userToolHost", () => {
  it("times each fetch out just after the tool's own limit", async () => {
    await expect(fetchTimeoutOf()).resolves.toMatchObject({ timeoutMs: fetchTimeoutFor(60_000) });
  });

  it("times each fetch out just after the call's capped limit when the caller caps it (a session deadline)", async () => {
    await expect(fetchTimeoutOf(5_000)).resolves.toMatchObject({ timeoutMs: fetchTimeoutFor(5_000) });
  });
});
