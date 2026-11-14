import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BLOB, substrateRunToken, toolActorSubject } from "../../jobs/substrate/names.js";
import { LocalBlobStore } from "../../storage/local.js";
import { capabilityHash } from "../capability-hash.js";
import type { ProxySession } from "../types.js";
import { MemoryRelayStore } from "./memory-relay-store.js";
import { RelayBusyError, RelayUnknownError, type RelayStore } from "./relay-store.js";
import { createSubstrateRoutes, type SubstrateRouteOptions } from "./routes.js";

const ATESPACE = "wardby-runs";
const CAPABILITY = "rrp_fake_capability_value_000001";
const OTHER_CAPABILITY = "rrp_fake_capability_value_000002";
const REGISTRY_TOKEN = "rrg_fake_registry_token_0000001";
const TOKEN = substrateRunToken("run-1");
const AUTH = { "x-wardby-actor-jwt": "Bearer good" };

const sessionFor = (runId: string): ProxySession =>
  ({ runId, deadlineAt: new Date(Date.now() + 60_000), status: "active" }) as ProxySession;

describe("substrate routes", () => {
  let dir: string;
  let blobs: LocalBlobStore;
  let relay: MemoryRelayStore;
  let server: Server;
  let base: string;
  let logCalls: unknown[][];
  let warnCalls: unknown[][];
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
      verifyActor: async (actorJwt, subject) =>
        actorJwt === "Bearer good" && subject === toolActorSubject(ATESPACE, TOKEN)
          ? { ok: true, subject }
          : { ok: false, code: "invalid" },
      tokenForRun: substrateRunToken,
      limits: { resultBytes: 1024, transcriptBytes: 1024, workspaceBytes: 64 },
      pollWaitMs: 100,
      log: { info: (...args) => void logCalls.push(args), warn: (...args) => void warnCalls.push(args) },
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
    warnCalls = [];
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
    expect((await fetch(`${base}/events?after=0`, { headers: { "x-wardby-actor-jwt": "Bearer bad" } })).status).toBe(
      401,
    );
    // The tool actor's JWT travels only in its own header: in Authorization it opens nothing.
    expect((await fetch(`${base}/events?after=0`, { headers: { authorization: "Bearer good" } })).status).toBe(401);
    expect((await fetch(`${base}/tool-setup`, { headers: { authorization: "Bearer good" } })).status).toBe(401);
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

  it("refuses a stopped session with a future deadline", async () => {
    overrides = {
      ledger: { findSessionByCapabilityHash: async () => ({ ...sessionFor("run-1"), status: "cancelled" }) },
    };
    await start();
    expect((await fetch(`${base}/channels`, agent({ method: "POST" }))).status).toBe(401);
  });

  it("requires Content-Length on uploads", async () => {
    await start();
    for (const [name, headers] of [
      ["result", { "x-api-key": CAPABILITY }],
      ["transcript", { "x-api-key": CAPABILITY }],
      ["workspace", AUTH],
    ] as const) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(`${base}/${name}`, { method: "POST", headers }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.write("abc");
        req.end();
      });
      expect(status).toBe(411);
    }
    expect(await blobs.head(BLOB.workspace(TOKEN))).toBeNull();
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

  it("stores the worker exit code and queues a collect request (agent only)", async () => {
    await start();
    const body = { method: "POST", body: JSON.stringify({ code: 3 }), headers: { "content-type": "application/json" } };
    expect((await fetch(`${base}/exit`, tool(body))).status).toBe(401);
    expect((await fetch(`${base}/exit`, { ...body, headers: { "x-api-key": OTHER_CAPABILITY } })).status).toBe(401);
    expect(await blobs.head(BLOB.exit(TOKEN))).toBeNull();
    expect((await fetch(`${base}/exit`, agent(body))).status).toBe(200);
    expect((await fetch(`${base}/exit`, agent(body))).status).toBe(200);
    expect(JSON.parse((await blobs.get(BLOB.exit(TOKEN))).toString())).toEqual({ code: 3 });
    const events = (await (await fetch(`${base}/events?after=0`, tool())).json()) as { events: { type: string }[] };
    expect(events.events.map((e) => e.type)).toContain("collect");
    for (const bad of ["{}", '{"code":"1"}', "[1]", "nope", '{"code":1.5}'])
      expect((await fetch(`${base}/exit`, agent({ method: "POST", body: bad }))).status).toBe(400);
    const big = await fetch(`${base}/exit`, agent({ method: "POST", body: " ".repeat(8 * 1024 + 1) }));
    expect(big.status).toBe(413);
  });

  it("stores the worker's safe diagnostic with its exit code", async () => {
    await start();
    const body = {
      code: 1,
      diagnostic: "coding_output_invalid",
      diagnosticIssues: ["summary:too_big", "$:invalid_type"],
    };
    expect((await fetch(`${base}/exit`, agent(json(body)))).status).toBe(200);
    expect(JSON.parse((await blobs.get(BLOB.exit(TOKEN))).toString())).toEqual(body);
  });

  it("refuses an exit report whose diagnostic is not a safe one, and stores nothing", async () => {
    await start();
    for (const bad of [
      { code: 1, diagnostic: "provider said sk-SECRET" },
      { code: 1, diagnostic: 5 },
      { code: 1, diagnostic: "coding_turn_limit", diagnosticIssues: ["summary:too_big", "sk-SECRET"] },
      { code: 1, diagnostic: "coding_turn_limit", diagnosticIssues: [] },
      { code: 1, diagnostic: "coding_turn_limit", diagnosticIssues: "summary:too_big" },
      { code: 1, diagnosticIssues: ["summary:too_big"] },
      { code: 1, diagnostic: "coding_turn_limit", extra: "x" },
    ]) {
      const answer = await fetch(`${base}/exit`, agent(json(bad)));
      expect(answer.status).toBe(400);
      expect(await answer.json()).toEqual({ error: { type: "bad_request" } });
    }
    expect(await blobs.head(BLOB.exit(TOKEN))).toBeNull();
  });

  it("answers exit twice after the workspace was uploaded and the relay dropped", async () => {
    await start();
    await fetch(`${base}/channels`, agent({ method: "POST" }));
    expect((await fetch(`${base}/workspace`, tool({ method: "POST", body: "tar" }))).status).toBe(200);
    const body = { method: "POST", body: JSON.stringify({ code: 3 }), headers: { "content-type": "application/json" } };
    expect((await fetch(`${base}/exit`, agent(body))).status).toBe(200);
    expect((await fetch(`${base}/exit`, agent(body))).status).toBe(200);
    expect(JSON.parse((await blobs.get(BLOB.exit(TOKEN))).toString())).toEqual({ code: 3 });
  });

  it("answers exit 200 when the relay is unknown, and does not collect again once the exit blob exists", async () => {
    await start();
    const collect = vi.spyOn(relay, "requestCollect").mockRejectedValue(new RelayUnknownError());
    const body = { method: "POST", body: JSON.stringify({ code: 4 }), headers: { "content-type": "application/json" } };
    expect((await fetch(`${base}/exit`, agent(body))).status).toBe(200);
    expect(collect).toHaveBeenCalledTimes(1);
    expect((await fetch(`${base}/exit`, agent(body))).status).toBe(200);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(JSON.parse((await blobs.get(BLOB.exit(TOKEN))).toString())).toEqual({ code: 4 });
  });

  describe("operator diagnostics", () => {
    const text = (body: string) => ({ method: "POST", body, headers: { "content-type": "text/plain" } });
    const allFiles = async (): Promise<string[]> =>
      (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);

    it("logs a bounded tail at warn for the operator, once per run and side, and stores or returns nothing", async () => {
      await start();
      const tail = "npm ERR! could not resolve\nexit 1";
      const answer = await fetch(`${base}/diagnostics`, agent(text(tail)));
      expect(answer.status).toBe(200);
      expect(await answer.text()).toBe("{}");
      // A repeat from the same side is ignored.
      expect((await fetch(`${base}/diagnostics`, agent(text("again")))).status).toBe(200);
      expect((await fetch(`${base}/diagnostics`, tool(text("tool side")))).status).toBe(200);
      expect((await fetch(`${base}/diagnostics`, tool(text("tool again")))).status).toBe(200);
      expect(warnCalls).toEqual([
        [{ event: "substrate.diagnostics", runToken: TOKEN, side: "agent", tail }, "substrate actor diagnostics"],
        [
          { event: "substrate.diagnostics", runToken: TOKEN, side: "tool", tail: "tool side" },
          "substrate actor diagnostics",
        ],
      ]);
      // Never stored: no blob was written by any of it.
      expect(await allFiles()).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(JSON.stringify(logCalls)).not.toContain("npm ERR");
    });

    it("refuses a tail that still holds a capability or registry token shape, and logs only a fixed event", async () => {
      await start();
      for (const [side, init, secret] of [
        ["agent", agent, CAPABILITY],
        ["tool", tool, REGISTRY_TOKEN],
      ] as const) {
        const answer = await fetch(`${base}/diagnostics`, init(text(`line one\nkey=${secret}\n`)));
        expect(answer.status).toBe(400);
        expect(await answer.json()).toEqual({ error: { type: "bad_request" } });
        expect(warnCalls.at(-1)).toEqual([
          { event: "substrate.diagnostics_rejected", runToken: TOKEN, side },
          "substrate actor diagnostics rejected",
        ]);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      const serialized = JSON.stringify([logCalls, warnCalls]);
      for (const secret of [CAPABILITY, REGISTRY_TOKEN, "line one"]) expect(serialized).not.toContain(secret);
      expect(await allFiles()).toEqual([]);
    });

    it("requires auth and a Content-Length within 8 KiB", async () => {
      await start();
      expect((await fetch(`${base}/diagnostics`, text("x"))).status).toBe(401);
      expect(
        (await fetch(`${base}/diagnostics`, { ...text("x"), headers: { "x-wardby-actor-jwt": "Bearer bad" } })).status,
      ).toBe(401);
      expect((await fetch(`${base}/diagnostics`, agent(text("y".repeat(8 * 1024 + 1))))).status).toBe(413);
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          `${base}/diagnostics`,
          { method: "POST", headers: { "x-api-key": CAPABILITY } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.write("abc");
        req.end();
      });
      expect(status).toBe(411);
      expect(warnCalls).toEqual([]);
    });
  });

  it("records a failed workspace and drops the relay (tool only)", async () => {
    await start();
    await fetch(`${base}/channels`, agent({ method: "POST" }));
    expect((await fetch(`${base}/workspace-failed`, agent({ method: "POST" }))).status).toBe(401);
    expect(await blobs.head(BLOB.done(TOKEN))).toBeNull();
    expect((await fetch(`${base}/workspace-failed`, tool({ method: "POST" }))).status).toBe(200);
    expect((await fetch(`${base}/workspace-failed`, tool({ method: "POST" }))).status).toBe(200);
    expect(JSON.parse((await blobs.get(BLOB.done(TOKEN))).toString())).toEqual({ workspace: "failed" });
    expect(await relay.pollTool(TOKEN, 0, 0)).toEqual([]);
    expect(await blobs.head(BLOB.workspace(TOKEN))).toBeNull();
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
    // A store error whose message holds a secret: only its kind is logged, nothing is echoed.
    const failing = new Error(`boom ${CAPABILITY}`);
    (failing as { code?: string }).code = "P2002";
    overrides = { relay: { openChannel: async () => Promise.reject(failing) } as unknown as RelayStore };
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await start();
    const failed = await fetch(`${base}/channels`, agent({ method: "POST" }));
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain(CAPABILITY);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(JSON.stringify(logCalls)).toContain("P2002");
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
