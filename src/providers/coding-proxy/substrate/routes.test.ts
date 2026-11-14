import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BLOB, substrateRunToken, toolActorSubject } from "../../jobs/substrate/names.js";
import { LocalBlobStore } from "../../storage/local.js";
import { capabilityHash } from "../capability-hash.js";
import type { ProxySession } from "../types.js";
import { MemoryRelayStore } from "./memory-relay-store.js";
import { RelayBusyError, type RelayStore } from "./relay-store.js";
import { createSubstrateRoutes, type SubstrateRouteOptions } from "./routes.js";

const ATESPACE = "wardby-runs";
const CAPABILITY = "rrp_fake_capability_value_000001";
const OTHER_CAPABILITY = "rrp_fake_capability_value_000002";
const REGISTRY_TOKEN = "rrg_fake_registry_token_0000001";
const TOKEN = substrateRunToken("run-1");
const AUTH = { authorization: "Bearer good" };

const sessionFor = (runId: string): ProxySession =>
  ({ runId, deadlineAt: new Date(Date.now() + 60_000), status: "active" }) as ProxySession;

describe("substrate routes", () => {
  let dir: string;
  let blobs: LocalBlobStore;
  let relay: MemoryRelayStore;
  let server: Server;
  let base: string;
  let logCalls: unknown[][];
  let overrides: Partial<SubstrateRouteOptions>;

  const start = async (): Promise<void> => {
    const handler = createSubstrateRoutes({
      atespace: ATESPACE,
      relay,
      blobs,
      ledger: {
        findSessionByCapabilityHash: async (hash) =>
          hash === capabilityHash(CAPABILITY)
            ? sessionFor("run-1")
            : hash === capabilityHash(OTHER_CAPABILITY)
              ? sessionFor("run-2")
              : null,
      },
      verifyActor: async (authorization, subject) =>
        authorization === "Bearer good" && subject === toolActorSubject(ATESPACE, TOKEN)
          ? { ok: true, subject }
          : { ok: false, code: "invalid" },
      tokenForRun: substrateRunToken,
      limits: { inputBytes: 1024, resultBytes: 1024, transcriptBytes: 1024, workspaceBytes: 64 },
      pollWaitMs: 100,
      log: { info: (...args) => void logCalls.push(args) },
      ...overrides,
    });
    server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/substrate/runs/${TOKEN}`;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "substrate-routes-"));
    blobs = new LocalBlobStore(dir);
    relay = new MemoryRelayStore();
    relay.register(TOKEN, 1 << 20);
    logCalls = [];
    overrides = {};
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server?.closeAllConnections();
    await rm(dir, { recursive: true, force: true });
  });

  const agent = (init: RequestInit = {}) => ({
    ...init,
    headers: { "x-api-key": CAPABILITY, ...(init.headers as Record<string, string> | undefined) },
  });
  const tool = (init: RequestInit = {}) => ({
    ...init,
    headers: { ...AUTH, ...(init.headers as Record<string, string> | undefined) },
  });
  const json = (body: unknown) => ({
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });

  it("relays lines both ways between the agent and the tool", async () => {
    await start();
    const opened = await fetch(`${base}/channels`, agent({ method: "POST" }));
    expect(opened.status).toBe(200);
    const { channel } = (await opened.json()) as { channel: string };
    expect(channel).toBe("c1");
    const sent = await fetch(`${base}/channels/${channel}/lines`, agent(json({ seq: 1, line: '{"jsonrpc":"2.0"}' })));
    expect(sent.status).toBe(200);

    const events = (await (await fetch(`${base}/events?after=0`, tool())).json()) as { events: unknown[] };
    expect(events.events).toEqual([
      { seq: 1, type: "open", channel: "c1" },
      { seq: 2, type: "line", channel: "c1", line: '{"jsonrpc":"2.0"}' },
    ]);

    const back = await fetch(`${base}/channels/${channel}/from-tool`, tool(json({ seq: 1, line: "reply" })));
    expect(back.status).toBe(200);
    const lines = (await (await fetch(`${base}/channels/${channel}/lines?after=0`, agent())).json()) as {
      events: unknown[];
    };
    expect(lines.events).toEqual([{ seq: 1, type: "line", line: "reply" }]);

    expect((await fetch(`${base}/channels/${channel}/lines`, agent(json({ close: true })))).status).toBe(200);
    expect((await fetch(`${base}/channels/${channel}/from-tool`, tool(json({ close: true })))).status).toBe(200);
    const after = (await (await fetch(`${base}/events?after=2`, tool())).json()) as { events: { type: string }[] };
    expect(after.events.map((e) => e.type)).toEqual(["close"]);
    const closed = (await (await fetch(`${base}/channels/${channel}/lines?after=1`, agent())).json()) as {
      events: { type: string }[];
    };
    expect(closed.events.map((e) => e.type)).toEqual(["close"]);
  });

  it("rejects wrong credentials with 401 unauthorized", async () => {
    await start();
    const wrong = await fetch(`${base}/channels`, { method: "POST", headers: { "x-api-key": "rrp_nope" } });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: { type: "unauthorized" } });
    expect((await fetch(`${base}/channels`, { method: "POST" })).status).toBe(401);
    // A real capability, but for another run.
    const other = await fetch(`${base}/channels`, { method: "POST", headers: { "x-api-key": OTHER_CAPABILITY } });
    expect(other.status).toBe(401);
    expect((await fetch(`${base}/events?after=0`, { headers: { authorization: "Bearer bad" } })).status).toBe(401);
    expect((await fetch(`${base}/events?after=0`, { headers: { "x-api-key": CAPABILITY } })).status).toBe(401);
    // The tool's JWT does not open an agent route, nor the capability a tool route.
    expect((await fetch(`${base}/channels`, { method: "POST", headers: AUTH })).status).toBe(401);
    expect((await fetch(`${base}/tool-setup`, agent())).status).toBe(401);
  });

  it("refuses an expired or cancelled session", async () => {
    overrides = {
      ledger: {
        findSessionByCapabilityHash: async () => ({ ...sessionFor("run-1"), deadlineAt: new Date(Date.now() - 1) }),
      },
    };
    await start();
    expect((await fetch(`${base}/channels`, agent({ method: "POST" }))).status).toBe(401);
  });

  it("answers unknown paths and unknown runs with fixed codes", async () => {
    await start();
    const missing = await fetch(`${base}/nothing`, agent());
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { type: "not_found" } });
    const unknown = await fetch(`${base}/channels/c9/lines?after=0`, agent());
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: { type: "relay_unknown" } });
  });

  it("serves tool-setup repeatedly, then 404 once the first events poll has run", async () => {
    await blobs.put(BLOB.toolSetup(TOKEN), Buffer.from('{"setup":true}'));
    await start();
    const first = await fetch(`${base}/tool-setup`, tool());
    expect(first.status).toBe(200);
    expect(await first.text()).toBe('{"setup":true}');
    expect((await fetch(`${base}/tool-setup`, tool())).status).toBe(200);
    expect((await fetch(`${base}/events?after=0`, tool())).status).toBe(200);
    const gone = await fetch(`${base}/tool-setup`, tool());
    expect(gone.status).toBe(404);
    expect(await gone.json()).toEqual({ error: { type: "not_found" } });
  });

  it("streams the input and seed blobs", async () => {
    await blobs.put(BLOB.input(TOKEN), Buffer.from('{"task":"x"}'));
    await blobs.put(BLOB.seed(TOKEN), Buffer.from("tar-bytes"));
    await start();
    expect(await (await fetch(`${base}/input`, agent())).text()).toBe('{"task":"x"}');
    expect(await (await fetch(`${base}/seed`, tool())).text()).toBe("tar-bytes");
    expect((await fetch(`${base}/input`, tool())).status).toBe(401);
  });

  it("stores the result and queues a collect request for the tool", async () => {
    await start();
    const put = await fetch(`${base}/result`, agent({ method: "POST", body: '{"final":"done"}' }));
    expect(put.status).toBe(200);
    expect((await blobs.get(BLOB.result(TOKEN))).toString()).toBe('{"final":"done"}');
    const events = (await (await fetch(`${base}/events?after=0`, tool())).json()) as { events: { type: string }[] };
    expect(events.events.map((e) => e.type)).toEqual(["collect"]);
    const big = await fetch(`${base}/result`, agent({ method: "POST", body: "x".repeat(2000) }));
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: { type: "too_large" } });
  });

  it("stores the transcript within its limit", async () => {
    await start();
    expect((await fetch(`${base}/transcript`, agent({ method: "POST", body: "line\n" }))).status).toBe(200);
    expect((await blobs.get(BLOB.transcript(TOKEN))).toString()).toBe("line\n");
    expect((await fetch(`${base}/transcript`, agent({ method: "POST", body: "x".repeat(2000) }))).status).toBe(413);
  });

  it("refuses an oversized workspace and writes no done marker", async () => {
    await start();
    const big = await fetch(`${base}/workspace`, tool({ method: "POST", body: "w".repeat(200) }));
    expect(big.status).toBe(413);
    expect(await blobs.head(BLOB.done(TOKEN))).toBeNull();
    expect(await blobs.head(BLOB.workspace(TOKEN))).toBeNull();
  });

  it("stores the workspace, writes the done marker and drops the relay", async () => {
    await start();
    await fetch(`${base}/channels`, agent({ method: "POST" }));
    const ok = await fetch(`${base}/workspace`, tool({ method: "POST", body: "tar" }));
    expect(ok.status).toBe(200);
    expect((await blobs.get(BLOB.workspace(TOKEN))).toString()).toBe("tar");
    expect(JSON.parse((await blobs.get(BLOB.done(TOKEN))).toString())).toEqual({ workspace: "ok" });
    // The relay was dropped: the cursor restarts at zero and no channels remain.
    expect(await relay.pollTool(TOKEN, 0, 0)).toEqual([]);
    expect((await fetch(`${base}/channels/c1/lines?after=0`, agent())).status).toBe(404);
  });

  it("answers 429 relay_backpressure when the relay is full", async () => {
    relay = new MemoryRelayStore();
    relay.register(TOKEN, 10);
    await start();
    await fetch(`${base}/channels`, agent({ method: "POST" }));
    const full = await fetch(`${base}/channels/c1/lines`, agent(json({ seq: 1, line: "x".repeat(50) })));
    expect(full.status).toBe(429);
    expect(await full.json()).toEqual({ error: { type: "relay_backpressure" } });
  });

  it("answers 503 relay_busy with Retry-After when the store is busy", async () => {
    const busy = { openChannel: async () => Promise.reject(new RelayBusyError()) } as unknown as RelayStore;
    overrides = { relay: busy };
    await start();
    const response = await fetch(`${base}/channels`, agent({ method: "POST" }));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await response.json()).toEqual({ error: { type: "relay_busy" } });
  });

  it("rejects malformed and oversized line posts", async () => {
    await start();
    await fetch(`${base}/channels`, agent({ method: "POST" }));
    const bad = await fetch(`${base}/channels/c1/lines`, agent(json({ seq: "1", line: 5 })));
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: { type: "bad_request" } });
    const huge = await fetch(
      `${base}/channels/c1/lines`,
      agent(json({ seq: 1, line: "x".repeat(4 * 1024 * 1024 + 1) })),
    );
    expect(huge.status).toBe(413);
  });

  it("keeps secret values out of every log call and error body", async () => {
    await blobs.put(BLOB.toolSetup(TOKEN), Buffer.from(JSON.stringify({ registryToken: REGISTRY_TOKEN })));
    await start();
    await fetch(`${base}/channels`, agent({ method: "POST" }));
    await fetch(`${base}/channels/c1/lines`, agent(json({ seq: 1, line: `{"key":"${CAPABILITY}"}` })));
    await fetch(`${base}/tool-setup`, tool());
    await fetch(`${base}/events?after=0`, tool());
    await fetch(`${base}/channels/c1/from-tool`, tool(json({ seq: 1, line: CAPABILITY })));
    await fetch(`${base}/channels/c1/lines?after=0`, agent());
    await fetch(`${base}/result`, agent({ method: "POST", body: CAPABILITY }));
    const denied = await fetch(`${base}/channels`, { method: "POST", headers: { "x-api-key": CAPABILITY + "x" } });
    const deniedBody = await denied.text();
    await fetch(`${base}/workspace`, tool({ method: "POST", body: "w".repeat(200) }));
    const serialized = JSON.stringify(logCalls);
    expect(logCalls.length).toBeGreaterThan(0);
    for (const secret of [CAPABILITY, REGISTRY_TOKEN, "Bearer good", "good"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(deniedBody).not.toContain(CAPABILITY);
    // What is logged: the run token, the route name and the numbers.
    expect(serialized).toContain(TOKEN);
  });
});
