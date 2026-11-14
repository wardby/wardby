import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BLOB, roundBlob, substrateRunToken, toolActorSubject } from "../../jobs/substrate/names.js";
import { LocalBlobStore } from "../../storage/local.js";
import { deriveRegistryToken } from "../../../coding/registry/token.js";
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

  const waitForBlob = async (key: string): Promise<void> => {
    for (let i = 0; i < 100 && !(await blobs.head(key)); i++) await new Promise((r) => setTimeout(r, 10));
  };
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

  it("records that the run started on the agent's first successful input download, once", async () => {
    await start();
    // No input yet: a 404 is not a start.
    expect((await fetch(`${base}/input`, agent())).status).toBe(404);
    expect(await blobs.head(BLOB.started(TOKEN))).toBeNull();
    await blobs.put(BLOB.input(TOKEN), Buffer.from('{"task":"x"}'));
    expect((await fetch(`${base}/input`, tool())).status).toBe(401);
    expect(await blobs.head(BLOB.started(TOKEN))).toBeNull();
    expect(await (await fetch(`${base}/input`, agent())).text()).toBe('{"task":"x"}');
    await waitForBlob(BLOB.started(TOKEN));
    const first = await blobs.head(BLOB.started(TOKEN));
    await blobs.put(BLOB.started(TOKEN), Buffer.from("{}"));
    const put = vi.spyOn(blobs, "put");
    expect((await fetch(`${base}/input`, agent())).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Put-if-absent: an existing record is never rewritten.
    expect(put.mock.calls.filter(([key]) => key === BLOB.started(TOKEN))).toEqual([]);
    expect(first).not.toBeNull();
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

  it("never changes a run's outcome once done is written: a late or forged workspace report is refused", async () => {
    await start();
    expect((await fetch(`${base}/workspace`, tool({ method: "POST", body: "tar" }))).status).toBe(200);
    const doneAt = (await blobs.head(BLOB.done(TOKEN)))?.updatedAt;
    for (const [path, init] of [
      ["workspace", tool({ method: "POST", body: "forged" })],
      ["workspace-failed", tool({ method: "POST" })],
    ] as const) {
      const answer = await fetch(`${base}/${path}`, init);
      expect(answer.status).toBe(409);
      expect(await answer.json()).toEqual({ error: { type: "substrate_run_collected" } });
    }
    expect((await blobs.get(BLOB.workspace(TOKEN))).toString()).toBe("tar");
    expect(JSON.parse((await blobs.get(BLOB.done(TOKEN))).toString())).toEqual({ workspace: "ok" });
    expect((await blobs.head(BLOB.done(TOKEN)))?.updatedAt).toEqual(doneAt);

    // And the other way round: a failed collect is not turned into a success.
    await blobs.delete(BLOB.done(TOKEN));
    await blobs.delete(BLOB.workspace(TOKEN));
    expect((await fetch(`${base}/workspace-failed`, tool({ method: "POST" }))).status).toBe(200);
    expect((await fetch(`${base}/workspace`, tool({ method: "POST", body: "late" }))).status).toBe(409);
    expect(await blobs.head(BLOB.workspace(TOKEN))).toBeNull();
    expect(JSON.parse((await blobs.get(BLOB.done(TOKEN))).toString())).toEqual({ workspace: "failed" });
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

    it("logs a bounded agent tail at warn for the operator, once per run, and stores or returns nothing", async () => {
      await start();
      const tail = "npm ERR! could not resolve\nexit 1";
      const answer = await fetch(`${base}/diagnostics`, agent(text(tail)));
      expect(answer.status).toBe(200);
      expect(await answer.text()).toBe("{}");
      // A repeat is ignored.
      expect((await fetch(`${base}/diagnostics`, agent(text("again")))).status).toBe(200);
      expect(warnCalls).toEqual([
        [{ event: "substrate.diagnostics", runToken: TOKEN, side: "agent", tail }, "substrate actor diagnostics"],
      ]);
      // Never stored: no blob was written by any of it.
      expect(await allFiles()).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(JSON.stringify(logCalls)).not.toContain("npm ERR");
    });

    it("redacts the agent tail itself, by exact value, against the run's capability and registry-only token", async () => {
      await start();
      const registry = deriveRegistryToken(CAPABILITY);
      // As an untrusted bridge might send it: nothing redacted, raw and JSON-escaped forms.
      const raw = `key=${CAPABILITY}\nnpmrc _authToken=${registry}\njson ${JSON.stringify({ k: `"${registry}"` })}\n`;
      expect((await fetch(`${base}/diagnostics`, agent(text(raw)))).status).toBe(200);
      const logged = (warnCalls[0]?.[0] as { tail?: string } | undefined)?.tail ?? "";
      expect(logged).toContain("key=[REDACTED]");
      expect(logged).toContain("npmrc _authToken=[REDACTED]");
      const serialized = JSON.stringify([logCalls, warnCalls]);
      for (const secret of [CAPABILITY, registry]) expect(serialized).not.toContain(secret);
    });

    it("refuses a tool-side tail unread and unlogged, even one carrying a raw registry token", async () => {
      await start();
      for (const body of [`registry ${REGISTRY_TOKEN}`, btoa(REGISTRY_TOKEN), "plain tool stderr"]) {
        const answer = await fetch(`${base}/diagnostics`, tool(text(body)));
        expect(answer.status).toBe(403);
        expect(await answer.json()).toEqual({ error: { type: "diagnostics_agent_only" } });
      }
      // The header decides, whatever the token: a bad or forged actor JWT is refused the same way.
      const forged = await fetch(`${base}/diagnostics`, {
        ...text(REGISTRY_TOKEN),
        headers: { "x-wardby-actor-jwt": "x", "x-api-key": CAPABILITY },
      });
      expect(forged.status).toBe(403);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(warnCalls).toEqual([]);
      const serialized = JSON.stringify([logCalls, warnCalls]);
      for (const secret of [REGISTRY_TOKEN, btoa(REGISTRY_TOKEN), "plain tool stderr"])
        expect(serialized).not.toContain(secret);
      expect(await allFiles()).toEqual([]);
    });

    it("refuses an agent tail that still holds a token shape it could not redact, and logs only a fixed event", async () => {
      await start();
      const answer = await fetch(`${base}/diagnostics`, agent(text(`line one\nkey=${OTHER_CAPABILITY}\n`)));
      expect(answer.status).toBe(400);
      expect(await answer.json()).toEqual({ error: { type: "bad_request" } });
      expect(warnCalls).toEqual([
        [
          { event: "substrate.diagnostics_rejected", runToken: TOKEN, side: "agent" },
          "substrate actor diagnostics rejected",
        ],
      ]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const serialized = JSON.stringify([logCalls, warnCalls]);
      for (const secret of [OTHER_CAPABILITY, "line one"]) expect(serialized).not.toContain(secret);
      expect(await allFiles()).toEqual([]);
    });

    it("requires auth and a Content-Length within 8 KiB", async () => {
      await start();
      expect((await fetch(`${base}/diagnostics`, text("x"))).status).toBe(401);
      expect(
        (await fetch(`${base}/diagnostics`, { ...text("x"), headers: { "x-api-key": OTHER_CAPABILITY } })).status,
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
    // The first report stands.
    expect((await fetch(`${base}/workspace-failed`, tool({ method: "POST" }))).status).toBe(409);
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

  describe("warm rounds", () => {
    // fetch sends Content-Length for a string body.
    const upload = (body: string) => ({ method: "POST", body });

    it("without warm rounds: a round query is never the current round, and round.json is not read", async () => {
      await start();
      await blobs.put(BLOB.input(TOKEN), Buffer.from('{"round":1}'));
      await blobs.put(roundBlob(TOKEN), Buffer.from('{"round":2}'));
      await blobs.put(BLOB.input(TOKEN, 2), Buffer.from('{"round":2}'));
      expect((await fetch(`${base}/input?round=2`, agent())).status).toBe(404);
      const first = await fetch(`${base}/input`, agent());
      expect(first.status).toBe(200);
      expect(await first.text()).toBe('{"round":1}');
      expect((await fetch(`${base}/result?round=2`, agent(upload("{}")))).status).toBe(409);
      expect((await fetch(`${base}/input?round=x`, agent())).status).toBe(400);
    });

    it("serves and stores the current round's files, for the run holding the token", async () => {
      // run-2 adopted run-1's actors: its row holds TOKEN; run-1's row moved to a retired token.
      overrides = {
        warmRounds: true,
        tokenForRun: async (runId) => (runId === "run-2" ? TOKEN : "wa-retired"),
      };
      await start();
      const run2 = (init: RequestInit = {}) => ({
        ...init,
        headers: { "x-api-key": OTHER_CAPABILITY, ...(init.headers as Record<string, string> | undefined) },
      });
      // Not staged yet: the bridge keeps waiting.
      expect((await fetch(`${base}/input?round=2`, run2())).status).toBe(404);
      await blobs.put(BLOB.input(TOKEN, 2), Buffer.from('{"round":2}'));
      expect((await fetch(`${base}/input?round=2`, run2())).status).toBe(404);
      await blobs.put(roundBlob(TOKEN), Buffer.from('{"round":2}'));
      const input = await fetch(`${base}/input?round=2`, run2());
      expect(input.status).toBe(200);
      expect(await input.text()).toBe('{"round":2}');
      expect(await blobs.head(BLOB.started(TOKEN, 2))).not.toBeNull();
      expect(await blobs.head(BLOB.started(TOKEN))).toBeNull();
      // Round 1's request, and round 1's run (its capability), are refused.
      expect((await fetch(`${base}/input`, run2())).status).toBe(404);
      expect((await fetch(`${base}/input?round=2`, agent())).status).toBe(401);
      // Uploads go to round 2's names; another round is a conflict.
      expect((await fetch(`${base}/result?round=2`, run2(upload('{"r":2}')))).status).toBe(200);
      expect((await blobs.get(BLOB.result(TOKEN, 2))).toString()).toBe('{"r":2}');
      expect((await fetch(`${base}/result`, run2(upload("{}")))).status).toBe(409);
      expect((await fetch(`${base}/transcript?round=2`, run2(upload("t")))).status).toBe(200);
      expect(await blobs.head(BLOB.transcript(TOKEN, 2))).not.toBeNull();
      const exit = JSON.stringify({ code: 3 });
      expect((await fetch(`${base}/exit?round=2`, run2(upload(exit)))).status).toBe(200);
      expect((await blobs.get(BLOB.exit(TOKEN, 2))).toString()).toBe(exit);
      expect(await blobs.head(BLOB.exit(TOKEN))).toBeNull();
      // The tool side: round 2's tool setup, deleted by round 2's first events poll, then the workspace.
      await blobs.put(BLOB.toolSetup(TOKEN), Buffer.from('{"toolSetup":"{}"}'));
      expect((await fetch(`${base}/tool-setup`, tool())).status).toBe(404);
      expect((await fetch(`${base}/tool-setup?round=2`, tool())).status).toBe(200);
      expect((await fetch(`${base}/events?after=0`, tool())).status).toBe(200);
      expect(await blobs.head(BLOB.toolSetup(TOKEN))).toBeNull();
      expect((await fetch(`${base}/workspace`, tool(upload("w")))).status).toBe(409);
      expect((await fetch(`${base}/workspace?round=2`, tool(upload("w")))).status).toBe(200);
      expect(await blobs.head(BLOB.workspace(TOKEN, 2))).not.toBeNull();
      expect(JSON.parse((await blobs.get(BLOB.done(TOKEN, 2))).toString())).toEqual({ workspace: "ok" });
      expect(await blobs.head(BLOB.done(TOKEN))).toBeNull();
    });

    it("fixes each round's done once written: round 1's done does not refuse round 2, a second report does", async () => {
      overrides = { warmRounds: true, tokenForRun: async () => TOKEN };
      await start();
      await blobs.put(BLOB.done(TOKEN), Buffer.from('{"workspace":"ok"}'));
      await blobs.put(roundBlob(TOKEN), Buffer.from('{"round":2}'));
      expect((await fetch(`${base}/workspace-failed?round=2`, tool(upload("{}")))).status).toBe(200);
      expect(JSON.parse((await blobs.get(BLOB.done(TOKEN, 2))).toString())).toEqual({ workspace: "failed" });
      const again = await fetch(`${base}/workspace?round=2`, tool(upload("w")));
      expect(again.status).toBe(409);
      expect(await again.json()).toEqual({ error: { type: "substrate_run_collected" } });
      expect(await blobs.head(BLOB.workspace(TOKEN, 2))).toBeNull();
      expect(JSON.parse((await blobs.get(BLOB.done(TOKEN, 2))).toString())).toEqual({ workspace: "failed" });
    });

    it("logs no capability or tool setup while serving rounds", async () => {
      overrides = { warmRounds: true, tokenForRun: async () => TOKEN };
      await start();
      await blobs.put(roundBlob(TOKEN), Buffer.from('{"round":2}'));
      await blobs.put(BLOB.input(TOKEN, 2), Buffer.from("{}"));
      await blobs.put(BLOB.toolSetup(TOKEN), Buffer.from(JSON.stringify({ toolSetup: REGISTRY_TOKEN })));
      await fetch(`${base}/input?round=2`, agent());
      await fetch(`${base}/tool-setup?round=2`, tool());
      await fetch(`${base}/result?round=3`, agent(upload("{}")));
      const logged = JSON.stringify([logCalls, warnCalls]);
      for (const secret of [CAPABILITY, REGISTRY_TOKEN]) expect(logged).not.toContain(secret);
    });
  });
});
