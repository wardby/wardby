import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BLOB,
  BRIDGE_PROTOCOL_HEADER,
  REPO_BLOB,
  roundBlob,
  substrateRunToken,
  toolActorSubject,
} from "../../jobs/substrate/names.js";
import type { SubstrateRunLayout } from "../../jobs/substrate/run-store.js";
import { LocalBlobStore } from "../../storage/local.js";
import { BlobStoreError } from "../../storage/types.js";
import { deriveRegistryToken } from "../../../coding/registry/token.js";
import { MAX_PLAN_FILES_WIRE_BYTES } from "../../../coding/protocol.js";
import { capabilityHash } from "../capability-hash.js";
import type { ProxySession } from "../types.js";
import { MemoryRelayStore } from "./memory-relay-store.js";
import { RelayBusyError, RelayUnknownError, type RelayStore } from "./relay-store.js";
import { createSubstrateRoutes, MCP_TOOLS_INPUT_HEADER, type SubstrateRouteOptions } from "./routes.js";

const ATESPACE = "wardby-runs";
const CAPABILITY = "rrp_fake_capability_value_000001";
const OTHER_CAPABILITY = "rrp_fake_capability_value_000002";
const REGISTRY_TOKEN = "rrg_fake_registry_token_0000001";
const TOKEN = substrateRunToken("run-1");
const AUTH = { "x-wardby-actor-jwt": "Bearer good" };

const sessionFor = (runId: string): ProxySession =>
  ({ runId, deadlineAt: new Date(Date.now() + 60_000), status: "active" }) as ProxySession;
const PIN = {
  exposedName: "docs__search",
  toolName: "search",
  serverId: "server-1",
  serverName: "docs",
  definition: { description: "d", inputSchema: { type: "object" } },
};
/** A session with `mcpTools` set as given (`undefined`: the field left out). */
const sessionWithPins = (runId: string, mcpTools: unknown): ProxySession =>
  (mcpTools === undefined ? sessionFor(runId) : { ...sessionFor(runId), mcpTools }) as ProxySession;
/** The answer's x-wardby-* header names. */
const wardbyHeaders = (res: Response): string[] => [...res.headers.keys()].filter((k) => k.startsWith("x-wardby-"));

describe("substrate routes", () => {
  // Every request names bridge protocol 1, as the bridges do; a case that needs it missing calls globalThis.fetch.
  const fetch = (url: string, init: RequestInit = {}) =>
    globalThis.fetch(url, {
      ...init,
      headers: { [BRIDGE_PROTOCOL_HEADER]: "1", ...(init.headers as Record<string, string> | undefined) },
    });
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
    // Close idle keep-alive connections as the server closes, or close() waits on them.
    await new Promise<void>((resolve) => {
      if (!server) return resolve();
      server.close(() => resolve());
      server.closeAllConnections();
    });
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
        const req = httpRequest(
          `${base}/${name}`,
          { method: "POST", headers: { ...headers, [BRIDGE_PROTOCOL_HEADER]: "1" } },
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

  it("stores the plan files within the protocol's limit, and never logs their text", async () => {
    await start();
    const body = JSON.stringify({ schemaVersion: 1, note: "rrc_fake_plan_secret_value" });
    expect((await fetch(`${base}/plan-files`, agent({ method: "POST", body }))).status).toBe(200);
    expect((await blobs.get(BLOB.planFiles(TOKEN))).toString()).toBe(body);
    // Declared over the limit: refused from the header, before any body is read.
    const big = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        `${base}/plan-files`,
        {
          method: "POST",
          headers: {
            "x-api-key": CAPABILITY,
            [BRIDGE_PROTOCOL_HEADER]: "1",
            "content-length": String(MAX_PLAN_FILES_WIRE_BYTES + 1),
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.write("abc");
    });
    expect(big).toBe(413);
    expect((await blobs.get(BLOB.planFiles(TOKEN))).toString()).toBe(body);
    // The tool side may not post plan files: the route is the agent's.
    expect((await fetch(`${base}/plan-files`, tool({ method: "POST", body: "{}" }))).status).toBe(401);
    const logged = JSON.stringify([logCalls, warnCalls]);
    expect(logged).not.toContain("rrc_fake_plan_secret_value");
    expect(logged).toContain('"route":"plan-files"');
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

  describe("bridge protocol", () => {
    const refusedBlob = async (): Promise<unknown> => {
      const body = await blobs.get(BLOB.bridgeRefused(TOKEN));
      return JSON.parse(body.toString());
    };
    const refusals = (): unknown[] =>
      warnCalls.filter((call) => (call[0] as { event?: string }).event === "substrate.bridge_refused");

    it.each([
      ["missing", undefined, null],
      ["2", "2", 2],
      ["0", "0", 0],
      ["not a number", "abc", null],
      ["too long", "1234567", null],
    ] as const)(
      "refuses an authenticated agent request with protocol %s: 426, the blob, one warn",
      async (_label, header, protocol) => {
        await blobs.put(BLOB.input(TOKEN), Buffer.from('{"task":"x"}'));
        await start();
        const answer = await globalThis.fetch(`${base}/input`, {
          headers: { "x-api-key": CAPABILITY, ...(header !== undefined ? { [BRIDGE_PROTOCOL_HEADER]: header } : {}) },
        });
        expect(answer.status).toBe(426);
        expect(await answer.json()).toEqual({ error: { type: "substrate_bridge_incompatible" } });
        expect(await refusedBlob()).toEqual({ protocol });
        expect(warnCalls).toHaveLength(1);
        expect(warnCalls[0][0]).toEqual({
          event: "substrate.bridge_refused",
          runToken: TOKEN,
          route: "input",
          protocol,
        });
        expect(await blobs.head(BLOB.started(TOKEN))).toBeNull();
      },
    );

    it("refuses the tool side the same way", async () => {
      await blobs.put(BLOB.toolSetup(TOKEN), Buffer.from('{"setup":true}'));
      await start();
      const answer = await globalThis.fetch(`${base}/tool-setup`, {
        headers: { ...AUTH, [BRIDGE_PROTOCOL_HEADER]: "2" },
      });
      expect(answer.status).toBe(426);
      expect(await answer.json()).toEqual({ error: { type: "substrate_bridge_incompatible" } });
      expect(await refusedBlob()).toEqual({ protocol: 2 });
      expect(refusals()).toEqual([
        [{ event: "substrate.bridge_refused", runToken: TOKEN, route: "tool-setup", protocol: 2 }, expect.any(String)],
      ]);
    });

    it("keeps the first refusal", async () => {
      await start();
      const first = await globalThis.fetch(`${base}/input`, {
        headers: { "x-api-key": CAPABILITY, [BRIDGE_PROTOCOL_HEADER]: "2" },
      });
      const second = await globalThis.fetch(`${base}/input`, { headers: { "x-api-key": CAPABILITY } });
      expect([first.status, second.status]).toEqual([426, 426]);
      expect(await refusedBlob()).toEqual({ protocol: 2 });
      expect(refusals()).toHaveLength(2);
    });

    it("never lets an unauthenticated request write it", async () => {
      await start();
      expect((await globalThis.fetch(`${base}/input`)).status).toBe(401);
      expect(await blobs.head(BLOB.bridgeRefused(TOKEN))).toBeNull();
      expect(warnCalls).toEqual([]);
      const wrong = await globalThis.fetch(`${base}/input`, {
        headers: { "x-api-key": "rrp_wrong", [BRIDGE_PROTOCOL_HEADER]: "2" },
      });
      expect(wrong.status).toBe(401);
      expect(await blobs.head(BLOB.bridgeRefused(TOKEN))).toBeNull();
      expect(refusals()).toEqual([]);
    });

    it("serves protocol 1 as before", async () => {
      await blobs.put(BLOB.input(TOKEN), Buffer.from('{"task":"x"}'));
      await start();
      const answer = await globalThis.fetch(`${base}/input`, {
        headers: { "x-api-key": CAPABILITY, [BRIDGE_PROTOCOL_HEADER]: "1" },
      });
      expect(answer.status).toBe(200);
      expect(await answer.text()).toBe('{"task":"x"}');
      expect(await blobs.head(BLOB.bridgeRefused(TOKEN))).toBeNull();
    });

    it("logs and stores nothing of a refused request", async () => {
      await start();
      const body = CAPABILITY.repeat(2);
      const answer = await globalThis.fetch(`${base}/result`, {
        method: "POST",
        headers: {
          "x-api-key": CAPABILITY,
          [BRIDGE_PROTOCOL_HEADER]: "2",
          // fetch sets Content-Length from the body.
          "content-type": "application/json",
        },
        body,
      });
      expect(answer.status).toBe(426);
      const text = await answer.text();
      const stored = (await blobs.get(BLOB.bridgeRefused(TOKEN))).toString();
      // Let the route's close line land.
      await new Promise((r) => setTimeout(r, 20));
      for (const out of [JSON.stringify(logCalls), JSON.stringify(warnCalls), text, stored]) {
        expect(out).not.toContain(CAPABILITY);
        expect(out).not.toContain("rrp_");
      }
      expect(await blobs.head(BLOB.result(TOKEN))).toBeNull();
    });
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

    it("refuses a tail with an MCP token shape or the unredacted MCP placeholder, and logs no tail", async () => {
      await start();
      const mcpShaped = "rmt_" + "A".repeat(43);
      for (const body of [`mcp ${mcpShaped}\n`, "header rmt_placeholder_injected_by_gateway\n"]) {
        const answer = await fetch(`${base}/diagnostics`, agent(text(body)));
        expect(answer.status).toBe(400);
        expect(await answer.json()).toEqual({ error: { type: "bad_request" } });
      }
      expect(warnCalls).toHaveLength(2);
      for (const [fields] of warnCalls) {
        expect(fields).toEqual({ event: "substrate.diagnostics_rejected", runToken: TOKEN, side: "agent" });
        expect(fields).not.toHaveProperty("tail");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      const serialized = JSON.stringify([logCalls, warnCalls]);
      for (const secret of [mcpShaped, "rmt_placeholder_injected_by_gateway"]) expect(serialized).not.toContain(secret);
      expect(await allFiles()).toEqual([]);
    });

    it("accepts a tail whose MCP placeholder the bridge already redacted", async () => {
      await start();
      const answer = await fetch(`${base}/diagnostics`, agent(text("header [redacted]\n")));
      expect(answer.status).toBe(200);
      expect(warnCalls).toEqual([
        [
          { event: "substrate.diagnostics", runToken: TOKEN, side: "agent", tail: "header [redacted]\n" },
          "substrate actor diagnostics",
        ],
      ]);
    });

    it("with warm rounds: logs each round's tail once (the seen key includes the round), and refuses another round's", async () => {
      overrides = { warmRounds: true, tokenForRun: async () => TOKEN };
      await start();
      expect((await fetch(`${base}/diagnostics`, agent(text("round one tail")))).status).toBe(200);
      expect((await fetch(`${base}/diagnostics?round=2`, agent(text("early")))).status).toBe(409);
      await blobs.put(roundBlob(TOKEN), Buffer.from('{"round":2}'));
      expect((await fetch(`${base}/diagnostics?round=2`, agent(text("round two tail")))).status).toBe(200);
      expect((await fetch(`${base}/diagnostics?round=2`, agent(text("again")))).status).toBe(200);
      expect(warnCalls).toEqual([
        [
          { event: "substrate.diagnostics", runToken: TOKEN, side: "agent", tail: "round one tail" },
          "substrate actor diagnostics",
        ],
        [
          { event: "substrate.diagnostics", runToken: TOKEN, side: "agent", round: 2, tail: "round two tail" },
          "substrate actor diagnostics",
        ],
      ]);
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
          { method: "POST", headers: { "x-api-key": CAPABILITY, [BRIDGE_PROTOCOL_HEADER]: "1" } },
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

  describe("image-incomplete", () => {
    const reportBlob = async (): Promise<unknown> =>
      JSON.parse((await blobs.get(BLOB.imageIncomplete(TOKEN))).toString());
    /** The route log lines of image-incomplete, once the answers closed. */
    const routeLines = async (): Promise<Record<string, unknown>[]> => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return logCalls
        .map((call) => call[0] as Record<string, unknown>)
        .filter((fields) => fields.event === "substrate.route" && fields.route === "image-incomplete");
    };

    it.each(["user", "runner", "tar", "workspace", "run_dir"])("stores the holder's %s report once", async (item) => {
      await start();
      const answer = await fetch(`${base}/image-incomplete`, tool(json({ item })));
      expect(answer.status).toBe(200);
      expect(await answer.json()).toEqual({});
      expect(await reportBlob()).toEqual({ item });
      const other = item === "tar" ? "runner" : "tar";
      expect((await fetch(`${base}/image-incomplete`, tool(json({ item: other })))).status).toBe(200);
      expect(await reportBlob()).toEqual({ item });
      const lines = await routeLines();
      expect(lines[0]).toMatchObject({ status: 200, item });
    });

    it.each([
      ["another word", JSON.stringify({ item: "other" }), 400],
      ["a capability", JSON.stringify({ item: CAPABILITY }), 400],
      ["an extra key", JSON.stringify({ item: "tar", extra: 1 }), 400],
      ["a bare string", JSON.stringify("tar"), 400],
      ["an array", JSON.stringify([]), 400],
      ["not JSON", "tar", 400],
      ["a 65-byte body", JSON.stringify({ item: "x".repeat(54) }), 413],
    ] as const)("refuses %s, and stores nothing", async (_label, body, status) => {
      if (status === 413) expect(Buffer.byteLength(body)).toBe(65);
      await start();
      const answer = await fetch(`${base}/image-incomplete`, tool({ method: "POST", body }));
      expect(answer.status).toBe(status);
      expect(await answer.json()).toEqual({ error: { type: status === 413 ? "too_large" : "bad_request" } });
      expect(await blobs.head(BLOB.imageIncomplete(TOKEN))).toBeNull();
      const lines = await routeLines();
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toHaveProperty("item");
      expect(JSON.stringify(logCalls)).not.toContain(CAPABILITY);
      expect(JSON.stringify(warnCalls)).not.toContain(CAPABILITY);
    });

    it("requires a Content-Length", async () => {
      await start();
      const { port } = server.address() as { port: number };
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            method: "POST",
            path: `/substrate/runs/${TOKEN}/image-incomplete`,
            headers: { ...AUTH, [BRIDGE_PROTOCOL_HEADER]: "1", "transfer-encoding": "chunked" },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end('{"item":"tar"}');
      });
      expect(status).toBe(411);
      expect(await blobs.head(BLOB.imageIncomplete(TOKEN))).toBeNull();
    });

    it("is holder-only", async () => {
      await start();
      expect((await fetch(`${base}/image-incomplete`, agent(json({ item: "tar" })))).status).toBe(401);
      expect(await blobs.head(BLOB.imageIncomplete(TOKEN))).toBeNull();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      overrides = { runLayoutForToken: async () => ({ shape: "single" }) };
      await start();
      expect((await fetch(`${base}/image-incomplete`, tool(json({ item: "tar" })))).status).toBe(401);
      expect(await blobs.head(BLOB.imageIncomplete(TOKEN))).toBeNull();
      expect((await fetch(`${base}/image-incomplete`, agent(json({ item: "tar" })))).status).toBe(200);
      expect(await reportBlob()).toEqual({ item: "tar" });
    });

    it("never ends the run", async () => {
      await start();
      expect((await fetch(`${base}/image-incomplete`, tool(json({ item: "workspace" })))).status).toBe(200);
      expect(await blobs.head(BLOB.done(TOKEN))).toBeNull();
      expect((await fetch(`${base}/events?after=0`, tool())).status).toBe(200);
    });
  });

  describe("single actor shape", () => {
    // fetch sends Content-Length for a string body.
    const upload = (body: string) => ({ method: "POST", body });
    const SETUP = JSON.stringify({ registryToken: deriveRegistryToken(CAPABILITY) });
    const single = (): void => {
      overrides = { ...overrides, runLayoutForToken: async () => ({ shape: "single" }) };
    };
    /** Every log line, info and warn, with nothing of a secret or a body in it. */
    const expectNoSecretsLogged = async (bodies: string[] = []): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const logged = JSON.stringify([logCalls, warnCalls]);
      for (const secret of [CAPABILITY, deriveRegistryToken(CAPABILITY), SETUP, "Bearer good", ...bodies])
        expect(logged).not.toContain(secret);
    };

    it("authorizes the holder routes with the capability only, never the actor JWT", async () => {
      single();
      await blobs.put(BLOB.toolSetup(TOKEN), Buffer.from(SETUP));
      await blobs.put(BLOB.seed(TOKEN), Buffer.from("tar-bytes"));
      const verifyActor = vi.fn(async () => ({ ok: true as const, subject: "x" }));
      overrides.verifyActor = verifyActor;
      await start();
      const setup = await fetch(`${base}/tool-setup`, agent());
      expect(setup.status).toBe(200);
      expect(await setup.text()).toBe(SETUP);
      expect(await (await fetch(`${base}/seed`, agent())).text()).toBe("tar-bytes");
      for (const path of ["tool-setup", "seed"]) {
        const refused = await fetch(`${base}/${path}`, tool());
        expect(refused.status).toBe(401);
        expect(await refused.json()).toEqual({ error: { type: "unauthorized" } });
      }
      expect((await fetch(`${base}/workspace`, tool(upload("w")))).status).toBe(401);
      expect((await fetch(`${base}/workspace-failed`, tool({ method: "POST" }))).status).toBe(401);
      expect(await blobs.head(BLOB.done(TOKEN))).toBeNull();
      // Another run's capability opens nothing.
      expect((await fetch(`${base}/seed`, { headers: { "x-api-key": OTHER_CAPABILITY } })).status).toBe(401);
      expect((await fetch(`${base}/workspace`, agent(upload("tar")))).status).toBe(200);
      expect((await blobs.get(BLOB.workspace(TOKEN))).toString()).toBe("tar");
      expect(JSON.parse((await blobs.get(BLOB.done(TOKEN))).toString())).toEqual({ workspace: "ok" });
      // The actor JWT is never consulted for a single-shape run.
      expect(verifyActor).not.toHaveBeenCalled();
      await expectNoSecretsLogged(["tar-bytes"]);
    });

    it("records a failed workspace for the capability holder", async () => {
      single();
      await start();
      expect((await fetch(`${base}/workspace-failed`, agent({ method: "POST" }))).status).toBe(200);
      expect(JSON.parse((await blobs.get(BLOB.done(TOKEN))).toString())).toEqual({ workspace: "failed" });
      expect((await fetch(`${base}/workspace`, agent(upload("late")))).status).toBe(409);
      await expectNoSecretsLogged(["late"]);
    });

    it("keeps today's rule for a pair run: the holder is the tool actor, by its JWT only", async () => {
      overrides = { runLayoutForToken: async () => ({ shape: "pair" }) };
      await blobs.put(BLOB.toolSetup(TOKEN), Buffer.from(SETUP));
      await start();
      expect((await fetch(`${base}/tool-setup`, agent())).status).toBe(401);
      expect((await fetch(`${base}/seed`, agent())).status).toBe(401);
      expect((await fetch(`${base}/workspace`, agent(upload("w")))).status).toBe(401);
      expect((await fetch(`${base}/workspace-failed`, agent({ method: "POST" }))).status).toBe(401);
      expect((await fetch(`${base}/tool-setup`, tool())).status).toBe(200);
      expect((await fetch(`${base}/workspace`, tool(upload("w")))).status).toBe(200);
      await expectNoSecretsLogged();
    });

    it("answers 404 on every relay route before any auth or relay call", async () => {
      single();
      const findSession = vi.fn(async () => sessionFor("run-1"));
      const verifyActor = vi.fn(async () => ({ ok: true as const, subject: "x" }));
      overrides.ledger = { findSessionByCapabilityHash: findSession };
      overrides.verifyActor = verifyActor;
      const relayCalls: string[] = [];
      overrides.relay = new Proxy(relay, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver) as unknown;
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            relayCalls.push(String(key));
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
      await start();
      for (const [path, init] of [
        ["events?after=0", tool()],
        ["events?after=0", agent()],
        ["channels", agent({ method: "POST" })],
        ["channels/c1/lines", agent(json({ seq: 1, line: CAPABILITY }))],
        ["channels/c1/lines?after=0", agent()],
        ["channels/c1/from-tool", tool(json({ seq: 1, line: CAPABILITY }))],
        ["channels/c1/from-tool", agent(json({ close: true }))],
      ] as const) {
        const answer = await fetch(`${base}/${path}`, init);
        expect([path, answer.status]).toEqual([path, 404]);
        expect(await answer.json()).toEqual({ error: { type: "not_found" } });
      }
      expect(relayCalls).toEqual([]);
      expect(findSession).not.toHaveBeenCalled();
      expect(verifyActor).not.toHaveBeenCalled();
      await expectNoSecretsLogged();
    });

    it("deletes the tool setup on the first input download, after recording the start; the input stays", async () => {
      single();
      await blobs.put(BLOB.input(TOKEN), Buffer.from('{"task":"x"}'));
      await blobs.put(BLOB.toolSetup(TOKEN), Buffer.from(SETUP));
      await start();
      // Not this run's capability: nothing recorded, nothing deleted.
      expect((await fetch(`${base}/input`, { headers: { "x-api-key": OTHER_CAPABILITY } })).status).toBe(401);
      expect(await blobs.head(BLOB.toolSetup(TOKEN))).not.toBeNull();
      expect(await (await fetch(`${base}/input`, agent())).text()).toBe('{"task":"x"}');
      // What the launcher's startup timeout reads: started, and no tool setup left.
      expect(await blobs.head(BLOB.started(TOKEN))).not.toBeNull();
      expect(await blobs.head(BLOB.toolSetup(TOKEN))).toBeNull();
      const again = await fetch(`${base}/input`, agent());
      expect(again.status).toBe(200);
      expect(await again.text()).toBe('{"task":"x"}');
      await expectNoSecretsLogged(['{"task":"x"}']);
    });

    it("answers the input even when the tool setup delete fails (best effort)", async () => {
      single();
      await blobs.put(BLOB.input(TOKEN), Buffer.from('{"task":"x"}'));
      overrides.blobs = Object.assign(Object.create(blobs) as LocalBlobStore, {
        delete: async () => {
          throw new BlobStoreError("not_found", "not_found");
        },
      });
      await start();
      expect(await (await fetch(`${base}/input`, agent())).text()).toBe('{"task":"x"}');
      expect(await blobs.head(BLOB.started(TOKEN))).not.toBeNull();
    });

    it("a pair run's input download leaves the tool setup for the tool's first events poll", async () => {
      overrides = { runLayoutForToken: async () => ({ shape: "pair" }) };
      await blobs.put(BLOB.input(TOKEN), Buffer.from('{"task":"x"}'));
      await blobs.put(BLOB.toolSetup(TOKEN), Buffer.from(SETUP));
      await start();
      expect((await fetch(`${base}/input`, agent())).status).toBe(200);
      expect(await blobs.head(BLOB.started(TOKEN))).not.toBeNull();
      expect(await blobs.head(BLOB.toolSetup(TOKEN))).not.toBeNull();
    });

    it("stores the result and the exit report without queuing a collect request", async () => {
      single();
      const collect = vi.spyOn(relay, "requestCollect");
      await start();
      expect((await fetch(`${base}/result`, agent(upload('{"final":"done"}')))).status).toBe(200);
      expect((await blobs.get(BLOB.result(TOKEN))).toString()).toBe('{"final":"done"}');
      const exit = JSON.stringify({ code: 3 });
      expect((await fetch(`${base}/exit`, agent(upload(exit)))).status).toBe(200);
      expect(JSON.parse((await blobs.get(BLOB.exit(TOKEN))).toString())).toEqual({ code: 3 });
      expect(collect).not.toHaveBeenCalled();
      await expectNoSecretsLogged(['{"final":"done"}']);
    });

    it("redacts the agent's diagnostics tail by exact value, escaped forms included, as for a pair run", async () => {
      single();
      await start();
      const registry = deriveRegistryToken(CAPABILITY);
      const raw = `key=${CAPABILITY}\nnpmrc ${registry}\njson ${JSON.stringify({ a: `"${CAPABILITY}"`, b: `"${registry}"` })}\n`;
      expect((await fetch(`${base}/diagnostics`, agent(upload(raw)))).status).toBe(200);
      expect(warnCalls).toHaveLength(1);
      const [fields] = warnCalls[0] as [{ side: string; tail: string }];
      expect(fields.side).toBe("agent");
      expect(fields.tail).toContain("key=[REDACTED]");
      expect(fields.tail).toContain("npmrc [REDACTED]");
      await expectNoSecretsLogged();
    });

    it("refuses a diagnostics tail with a token shape it could not redact, and logs no tail", async () => {
      single();
      await start();
      const answer = await fetch(`${base}/diagnostics`, agent(upload("before rrg_SOMETHING_ELSE after")));
      expect(answer.status).toBe(400);
      expect(warnCalls).toEqual([
        [
          { event: "substrate.diagnostics_rejected", runToken: TOKEN, side: "agent" },
          "substrate actor diagnostics rejected",
        ],
      ]);
      await expectNoSecretsLogged(["rrg_SOMETHING_ELSE", "before"]);
    });

    it("answers 500 with the fixed body when the shape lookup fails, and logs only the route line", async () => {
      const failing = new Error(`lookup failed ${CAPABILITY}`);
      overrides = { runLayoutForToken: async () => Promise.reject(failing) };
      await blobs.put(BLOB.toolSetup(TOKEN), Buffer.from(SETUP));
      await start();
      const answer = await fetch(`${base}/tool-setup`, agent());
      expect(answer.status).toBe(500);
      expect(await answer.json()).toEqual({ error: { type: "internal_error" } });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(logCalls).toHaveLength(1);
      expect(logCalls[0]?.[0]).toMatchObject({ event: "substrate.route", route: "tool-setup", status: 500 });
      expect(warnCalls).toEqual([]);
      await expectNoSecretsLogged(["lookup failed"]);
    });

    it("remembers the shape of a token whose row exists, and asks again while there is none", async () => {
      for (const shape of ["single", "pair"] as const) {
        const lookup = vi.fn(async (): Promise<SubstrateRunLayout | undefined> => ({ shape }));
        overrides = { runLayoutForToken: lookup };
        await blobs.put(BLOB.seed(TOKEN), Buffer.from("s"));
        await start();
        const holder = shape === "single" ? agent : tool;
        expect((await fetch(`${base}/seed`, holder())).status).toBe(200);
        expect((await fetch(`${base}/seed`, holder())).status).toBe(200);
        expect(lookup).toHaveBeenCalledTimes(1);
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
      // No row yet: treated as pair, and not remembered (the row may appear).
      const lookup = vi.fn(async (): Promise<SubstrateRunLayout | undefined> => undefined);
      overrides = { runLayoutForToken: lookup };
      await start();
      expect((await fetch(`${base}/seed`, tool())).status).toBe(200);
      expect((await fetch(`${base}/seed`, tool())).status).toBe(200);
      expect(lookup).toHaveBeenCalledTimes(2);
      lookup.mockResolvedValue({ shape: "single" });
      expect((await fetch(`${base}/seed`, agent())).status).toBe(200);
      expect((await fetch(`${base}/seed`, tool())).status).toBe(401);
      expect(lookup).toHaveBeenCalledTimes(3);
    });

    it("refuses a request with neither credential header before the shape lookup", async () => {
      const lookup = vi.fn(async (): Promise<SubstrateRunLayout | undefined> => ({ shape: "single" }));
      const verifyActor = vi.fn(async () => ({ ok: true as const, subject: "x" }));
      overrides = { runLayoutForToken: lookup, verifyActor };
      await blobs.put(BLOB.seed(TOKEN), Buffer.from("s"));
      await start();
      for (const [path, init] of [
        ["seed", {}],
        ["input", {}],
        ["events?after=0", {}],
        ["channels", { method: "POST" }],
        ["workspace", upload("w")],
        ["seed", { headers: { "x-api-key": "" } }],
      ] as const) {
        const answer = await fetch(`${base}/${path}`, init);
        expect(answer.status).toBe(401);
        expect(await answer.json()).toEqual({ error: { type: "unauthorized" } });
      }
      expect(lookup).not.toHaveBeenCalled();
      expect(verifyActor).not.toHaveBeenCalled();
      expect(await blobs.head(BLOB.done(TOKEN))).toBeNull();
    });

    it("logs whether a single run's input deleted its setup, as a fixed field", async () => {
      single();
      await blobs.put(BLOB.toolSetup(TOKEN), Buffer.from(SETUP));
      await blobs.put(BLOB.input(TOKEN), Buffer.from('{"task":"t"}'));
      await start();
      expect((await fetch(`${base}/input`, agent())).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const inputLines = () =>
        logCalls.map((call) => call[0] as Record<string, unknown>).filter((line) => line.route === "input");
      expect(inputLines()).toEqual([
        expect.objectContaining({ event: "substrate.route", status: 200, setupDeleted: true }),
      ]);
      await expectNoSecretsLogged(['{"task":"t"}']);
    });

    it("logs no setupDeleted field on a pair run's input", async () => {
      overrides = { runLayoutForToken: async () => ({ shape: "pair" }) };
      await blobs.put(BLOB.input(TOKEN), Buffer.from('{"task":"t"}'));
      await start();
      expect((await fetch(`${base}/input`, agent())).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const line = logCalls.map((call) => call[0] as Record<string, unknown>).find((l) => l.route === "input");
      expect(line).toBeDefined();
      expect(line).not.toHaveProperty("setupDeleted");
    });
  });

  describe("MCP tools on the input answer", () => {
    const pinned = (mcpTools: unknown): void => {
      overrides = {
        ...overrides,
        ledger: {
          findSessionByCapabilityHash: async (hash) =>
            hash === capabilityHash(CAPABILITY) ? sessionWithPins("run-1", mcpTools) : null,
        },
      };
    };

    it("names the header the bridges read", () => {
      expect(MCP_TOOLS_INPUT_HEADER).toBe("x-wardby-mcp-tools");
    });

    it("marks the input answer when the session has MCP tools, and only then", async () => {
      await blobs.put(BLOB.input(TOKEN), Buffer.from('{"task":"x"}'));
      for (const [mcpTools, expected] of [
        [[PIN], "1"],
        [undefined, null],
        [[], null],
        [null, null],
      ] as const) {
        pinned(mcpTools);
        await start();
        const res = await fetch(`${base}/input`, agent());
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('{"task":"x"}');
        expect(res.headers.get("x-wardby-mcp-tools")).toBe(expected);
        expect(wardbyHeaders(res)).toEqual(expected === null ? [] : ["x-wardby-mcp-tools"]);
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
    });

    it("a 404 input (not staged) carries no MCP header", async () => {
      pinned([PIN]);
      await start();
      const res = await fetch(`${base}/input`, agent());
      expect(res.status).toBe(404);
      expect(res.headers.get("x-wardby-mcp-tools")).toBeNull();
      expect(wardbyHeaders(res)).toEqual([]);
    });

    it("no other route's answer carries it", async () => {
      pinned([PIN]);
      await blobs.put(BLOB.seed(TOKEN), Buffer.from("tar-bytes"));
      await blobs.put(BLOB.toolSetup(TOKEN), Buffer.from("{}"));
      await start();
      for (const res of [
        await fetch(`${base}/seed`, tool()),
        await fetch(`${base}/tool-setup`, tool()),
        await fetch(`${base}/channels`, agent({ method: "POST" })),
        await fetch(`${base}/result`, agent({ method: "POST", body: "{}" })),
      ]) {
        expect(res.status).toBe(200);
        expect(wardbyHeaders(res)).toEqual([]);
      }
    });

    it("marks a single-shape run's input the same way", async () => {
      pinned([PIN]);
      overrides = { ...overrides, runLayoutForToken: async () => ({ shape: "single" }) };
      await blobs.put(BLOB.input(TOKEN), Buffer.from('{"task":"x"}'));
      await start();
      const res = await fetch(`${base}/input`, agent());
      expect(res.status).toBe(200);
      expect(res.headers.get("x-wardby-mcp-tools")).toBe("1");
    });

    it("logs the input route with exactly today's keys, no MCP field", async () => {
      pinned([PIN]);
      await blobs.put(BLOB.input(TOKEN), Buffer.from('{"task":"x"}'));
      await start();
      expect((await fetch(`${base}/input`, agent())).status).toBe(200);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const lines = logCalls.map((call) => call[0] as Record<string, unknown>).filter((l) => l.route === "input");
      expect(lines).toHaveLength(1);
      expect(Object.keys(lines[0]).sort()).toEqual(
        ["bytes", "durationMs", "event", "route", "runToken", "status"].sort(),
      );
      expect(JSON.stringify(logCalls)).not.toContain("docs__search");
    });
  });

  describe("warm rounds", () => {
    // fetch sends Content-Length for a string body.
    const upload = (body: string) => ({ method: "POST", body });

    it("each round's input answer follows that round's own session's MCP tools", async () => {
      for (const [run2Pins, expected] of [
        [[PIN], "1"],
        [null, null],
      ] as const) {
        overrides = {
          warmRounds: true,
          ledger: {
            findSessionByCapabilityHash: async (hash) =>
              hash === capabilityHash(CAPABILITY)
                ? sessionWithPins("run-1", null)
                : hash === capabilityHash(OTHER_CAPABILITY)
                  ? sessionWithPins("run-2", run2Pins)
                  : null,
          },
          tokenForRun: async (runId) => (runId === "run-2" ? TOKEN : "wa-retired"),
        };
        await start();
        await blobs.put(roundBlob(TOKEN), Buffer.from('{"round":2}'));
        await blobs.put(BLOB.input(TOKEN, 2), Buffer.from('{"round":2}'));
        const res = await fetch(`${base}/input?round=2`, { headers: { "x-api-key": OTHER_CAPABILITY } });
        expect(res.status).toBe(200);
        expect(res.headers.get("x-wardby-mcp-tools")).toBe(expected);
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
    });

    it("without warm rounds: round 1 as before; a round above 1 is refused (input 404, uploads 409), nothing read or written", async () => {
      await start();
      await blobs.put(BLOB.input(TOKEN), Buffer.from('{"round":1}'));
      await blobs.put(roundBlob(TOKEN), Buffer.from('{"round":2}'));
      await blobs.put(BLOB.input(TOKEN, 2), Buffer.from('{"round":2}'));
      for (const query of ["", "?round=1"]) {
        const answer = await fetch(`${base}/input${query}`, agent());
        expect(answer.status).toBe(200);
        expect(await answer.text()).toBe('{"round":1}');
      }
      expect((await fetch(`${base}/input?round=2`, agent())).status).toBe(404);
      expect(await blobs.head(BLOB.started(TOKEN, 2))).toBeNull();
      expect((await fetch(`${base}/result?round=2`, agent(upload('{"r":2}')))).status).toBe(409);
      expect(await blobs.head(BLOB.result(TOKEN, 2))).toBeNull();
      expect(await blobs.head(BLOB.result(TOKEN))).toBeNull();
      expect((await fetch(`${base}/result`, agent(upload('{"r":1}')))).status).toBe(200);
      expect((await blobs.get(BLOB.result(TOKEN))).toString()).toBe('{"r":1}');
      expect((await fetch(`${base}/transcript?round=x`, agent(upload("t")))).status).toBe(400);
      await blobs.put(BLOB.toolSetup(TOKEN), Buffer.from('{"toolSetup":"{}"}'));
      expect((await fetch(`${base}/tool-setup?round=3`, tool())).status).toBe(404);
      expect((await fetch(`${base}/tool-setup`, tool())).status).toBe(200);
      expect((await fetch(`${base}/workspace?round=2`, tool(upload("w")))).status).toBe(409);
      expect(await blobs.head(BLOB.done(TOKEN))).toBeNull();
      expect(await blobs.head(BLOB.done(TOKEN, 2))).toBeNull();
      expect((await fetch(`${base}/workspace`, tool(upload("w")))).status).toBe(200);
      expect(JSON.parse((await blobs.get(BLOB.done(TOKEN))).toString())).toEqual({ workspace: "ok" });
    });

    it("without warm rounds, a failed tool-setup delete on the first events poll answers its error, as before", async () => {
      const failing = (code: "not_found" | "blob_too_large") =>
        Object.assign(Object.create(blobs) as LocalBlobStore, {
          delete: async () => {
            throw new BlobStoreError(code, code);
          },
        });
      overrides = { blobs: failing("not_found") };
      await start();
      const answer = await fetch(`${base}/events?after=0`, tool());
      expect(answer.status).toBe(404);
      expect(await answer.json()).toEqual({ error: { type: "not_found" } });
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      // With warm rounds a tool setup already gone is fine (a later round stages it again).
      overrides = { blobs: failing("not_found"), warmRounds: true, tokenForRun: async () => TOKEN };
      await start();
      expect((await fetch(`${base}/events?after=0`, tool())).status).toBe(200);
    });

    it("refuses a finished round's capability (its session was cancelled) on every agent route, the next round's input included", async () => {
      // run-1 (round 1) finished: the executor cancelled its session before its actors were parked.
      // run-2 adopted them and holds the token now.
      let run1Status: "active" | "cancelled" = "active";
      let holder = "run-1";
      overrides = {
        warmRounds: true,
        ledger: {
          findSessionByCapabilityHash: async (hash) =>
            hash === capabilityHash(CAPABILITY)
              ? { ...sessionFor("run-1"), status: run1Status }
              : hash === capabilityHash(OTHER_CAPABILITY)
                ? sessionFor("run-2")
                : null,
        },
        tokenForRun: async (runId) => (runId === holder ? TOKEN : "wa-retired"),
      };
      await start();
      await blobs.put(BLOB.input(TOKEN), Buffer.from('{"round":1}'));
      // While round 1 runs, its capability works.
      expect((await fetch(`${base}/input`, agent())).status).toBe(200);
      run1Status = "cancelled";
      const routes: Array<[string, RequestInit]> = [
        ["input", {}],
        ["input?round=2", {}],
        ["channels", { method: "POST" }],
        ["channels/c1/lines", json({ seq: 1, line: "x" })],
        ["channels/c1/lines?after=0", {}],
        ["result", upload("{}")],
        ["result?round=2", upload("{}")],
        ["transcript?round=2", upload("t")],
        ["exit?round=2", upload(JSON.stringify({ code: 1 }))],
        ["diagnostics?round=2", upload("tail")],
      ];
      // Before and after the adoption: refused, whatever round it names.
      for (const adopted of [false, true]) {
        if (adopted) {
          holder = "run-2";
          await blobs.put(roundBlob(TOKEN), Buffer.from('{"round":2}'));
          await blobs.put(BLOB.input(TOKEN, 2), Buffer.from('{"round":2}'));
        }
        for (const [path, init] of routes) {
          const answer = await fetch(`${base}/${path}`, agent(init));
          expect([path, answer.status]).toEqual([path, 401]);
          expect(await answer.json()).toEqual({ error: { type: "unauthorized" } });
        }
      }
      // The adopting run's own capability is served.
      const input = await fetch(`${base}/input?round=2`, { headers: { "x-api-key": OTHER_CAPABILITY } });
      expect(input.status).toBe(200);
      // Nothing was written for the refused requests.
      expect(await blobs.head(BLOB.result(TOKEN))).toBeNull();
      expect(await blobs.head(BLOB.result(TOKEN, 2))).toBeNull();
      expect(await blobs.head(BLOB.exit(TOKEN, 2))).toBeNull();
      expect(warnCalls).toEqual([]);
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

  describe("extra repositories", () => {
    // fetch sends Content-Length for a string body.
    const upload = (body: string) => ({ method: "POST", body });
    const LAYOUT: SubstrateRunLayout = {
      shape: "pair",
      repositories: [
        { name: "extra-alpha", access: "write" },
        { name: "extra-beta", access: "read" },
      ],
    };
    beforeEach(() => {
      overrides = { runLayoutForToken: async () => LAYOUT };
    });
    const routeLines = (): Record<string, unknown>[] =>
      logCalls.map((call) => call[0] as Record<string, unknown>).filter((l) => l.event === "substrate.route");
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

    it("serves a listed repository's seed to the holder", async () => {
      await blobs.put(REPO_BLOB.seed(TOKEN, "extra-beta"), Buffer.from("seed-beta"));
      await blobs.put(REPO_BLOB.seed(TOKEN, "extra-alpha"), Buffer.from("seed-alpha"));
      await start();
      for (const [name, body] of [
        ["extra-beta", "seed-beta"],
        ["extra-alpha", "seed-alpha"],
      ] as const) {
        const answer = await fetch(`${base}/repos/${name}/seed`, tool());
        expect(answer.status).toBe(200);
        expect(answer.headers.get("content-type")).toBe("application/x-tar");
        expect(await answer.text()).toBe(body);
      }
    });

    it("refuses an unknown repository's seed, and the agent on a pair run", async () => {
      await blobs.put(REPO_BLOB.seed(TOKEN, "extra-gamma"), Buffer.from("seed-gamma"));
      await blobs.put(REPO_BLOB.seed(TOKEN, "extra-beta"), Buffer.from("seed-beta"));
      await start();
      const unknown = await fetch(`${base}/repos/extra-gamma/seed`, tool());
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toEqual({ error: { type: "not_found" } });
      const asAgent = await fetch(`${base}/repos/extra-beta/seed`, agent());
      expect(asAgent.status).toBe(401);
      expect(await asAgent.json()).toEqual({ error: { type: "unauthorized" } });
    });

    it("stores a writable repository's upload without ending the run", async () => {
      await start();
      const answer = await fetch(`${base}/repos/extra-alpha/workspace`, tool(upload("tar")));
      expect(answer.status).toBe(200);
      expect((await blobs.get(REPO_BLOB.workspace(TOKEN, "extra-alpha"))).toString()).toBe("tar");
      expect(await blobs.head(BLOB.done(TOKEN))).toBeNull();
      expect(await blobs.head(BLOB.workspace(TOKEN))).toBeNull();
      // The relay was not dropped: the tool's events poll still answers.
      expect((await fetch(`${base}/events?after=0`, tool())).status).toBe(200);
    });

    it.each(["extra-beta", "extra-gamma"])(
      "refuses an upload to %s (read or unknown), writing nothing",
      async (name) => {
        await start();
        const answer = await fetch(`${base}/repos/${name}/workspace`, tool(upload("tar")));
        expect(answer.status).toBe(404);
        expect(await answer.json()).toEqual({ error: { type: "not_found" } });
        expect(await blobs.head(REPO_BLOB.workspace(TOKEN, name))).toBeNull();
        expect(await blobs.head(BLOB.done(TOKEN))).toBeNull();
      },
    );

    it("caps each repository upload at the workspace limit", async () => {
      await start();
      const answer = await fetch(`${base}/repos/extra-alpha/workspace`, tool(upload("x".repeat(65))));
      expect(answer.status).toBe(413);
      expect(await answer.json()).toEqual({ error: { type: "too_large" } });
      expect(await blobs.head(REPO_BLOB.workspace(TOKEN, "extra-alpha"))).toBeNull();
    });

    it("refuses an upload after done", async () => {
      await blobs.put(BLOB.done(TOKEN), Buffer.from(JSON.stringify({ workspace: "ok" })));
      await start();
      const answer = await fetch(`${base}/repos/extra-alpha/workspace`, tool(upload("tar")));
      expect(answer.status).toBe(409);
      expect(await answer.json()).toEqual({ error: { type: "substrate_run_collected" } });
      expect(await blobs.head(REPO_BLOB.workspace(TOKEN, "extra-alpha"))).toBeNull();
    });

    it("refuses another round's upload", async () => {
      await start();
      const answer = await fetch(`${base}/repos/extra-alpha/workspace?round=2`, tool(upload("tar")));
      expect(answer.status).toBe(409);
      expect(await answer.json()).toEqual({ error: { type: "round_mismatch" } });
      expect(await blobs.head(REPO_BLOB.workspace(TOKEN, "extra-alpha", 2))).toBeNull();
      expect(await blobs.head(REPO_BLOB.workspace(TOKEN, "extra-alpha"))).toBeNull();
    });

    it.each([
      ["GET", "repos/workspace/seed"],
      ["GET", "repos/Extra/seed"],
      ["GET", "repos/extra-alpha/b/seed"],
      ["GET", "repos/extra-alpha/other"],
      ["GET", "repos/extra-alpha/workspace"],
      ["POST", "repos/extra-alpha/seed"],
      ["GET", "repos/a%2Fb/seed"],
      ["POST", "repos/a%2Fb/workspace"],
      ["GET", `repos/${"a".repeat(64)}/seed`],
      ["POST", `repos/${"a".repeat(64)}/workspace`],
    ])("%s %s is unmatched", async (method, path) => {
      const lookup = vi.fn(async () => LAYOUT);
      overrides = { runLayoutForToken: lookup };
      await start();
      const answer = await fetch(`${base}/${path}`, tool(method === "POST" ? upload("tar") : {}));
      expect(answer.status).toBe(404);
      expect(await answer.json()).toEqual({ error: { type: "not_found" } });
      await settle();
      expect(routeLines()).toEqual([expect.objectContaining({ route: "unmatched", status: 404 })]);
      expect(routeLines()[0]).not.toHaveProperty("repository");
      expect(lookup).not.toHaveBeenCalled();
    });

    it("a_b is a valid link name: matched, but 404 and unlogged when the row does not list it", async () => {
      await start();
      expect((await fetch(`${base}/repos/a_b/seed`, tool())).status).toBe(404);
      expect((await fetch(`${base}/repos/a_b/workspace`, tool(upload("tar")))).status).toBe(404);
      expect(await blobs.head(REPO_BLOB.workspace(TOKEN, "a_b"))).toBeNull();
      await settle();
      expect(routeLines()).toEqual([
        expect.objectContaining({ route: "repos.seed", status: 404 }),
        expect.objectContaining({ route: "repos.workspace", status: 404 }),
      ]);
      for (const line of routeLines()) expect(line).not.toHaveProperty("repository");
    });

    /** A request sent with its path exactly as given (fetch and URL parsing would resolve dot segments). */
    const raw = (
      method: string,
      path: string,
      headers: Record<string, string>,
      body?: string,
    ): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        const { hostname, port, pathname } = new URL(base);
        const req = httpRequest({ hostname, port, method, path: `${pathname}/${path}`, headers }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
        });
        req.on("error", reject);
        if (body !== undefined) req.write(body);
        req.end();
      });

    it.each([
      ["GET", "repos/%2e%2e/seed"],
      ["GET", "repos/%2E%2e/seed"],
      ["POST", "repos/%2e%2e/workspace"],
      ["POST", "repos/../workspace"],
      ["GET", "repos/./seed"],
      // URL parsing reads `\` as `/` for http: each of these would otherwise resolve to `workspace`.
      ["POST", "repos\\..\\workspace"],
      ["POST", "repos/a\\..\\..\\workspace"],
      ["POST", "repos%5c..\\..\\workspace"],
      ["POST", "repos%5c..%5cworkspace"],
    ])("%s %s (a path URL parsing changes) is unmatched and never reaches the default routes", async (method, path) => {
      const lookup = vi.fn(async () => LAYOUT);
      overrides = { runLayoutForToken: lookup };
      await blobs.put(BLOB.seed(TOKEN), Buffer.from("default-seed"));
      await start();
      const body = method === "POST" ? "tar" : undefined;
      const headers = { ...AUTH, ...(body !== undefined ? { "content-length": String(body.length) } : {}) };
      const answer = await raw(method, path, headers, body);
      expect(answer.status).toBe(404);
      expect(JSON.parse(answer.body)).toEqual({ error: { type: "not_found" } });
      expect(await blobs.head(BLOB.workspace(TOKEN))).toBeNull();
      expect(await blobs.head(BLOB.done(TOKEN))).toBeNull();
      await settle();
      expect(routeLines()).toEqual([expect.objectContaining({ route: "unmatched", status: 404 })]);
      expect(routeLines()[0]).not.toHaveProperty("repository");
      expect(lookup).not.toHaveBeenCalled();
    });

    it.each(["extra-beta", "extra-gamma"])(
      "refuses an upload to %s before its body is read",
      async (name) => {
        await start();
        // Content-Length declared, body never sent: an answer proves the route did not wait to read it.
        const status = await new Promise<number>((resolve, reject) => {
          const req = httpRequest(
            `${base}/repos/${name}/workspace`,
            { method: "POST", headers: { ...AUTH, [BRIDGE_PROTOCOL_HEADER]: "1", "content-length": "40" } },
            (res) => {
              res.resume();
              resolve(res.statusCode ?? 0);
            },
          );
          req.on("error", reject);
          req.flushHeaders();
        });
        expect(status).toBe(404);
        expect(await blobs.head(REPO_BLOB.workspace(TOKEN, name))).toBeNull();
      },
      2_000,
    );

    it("refuses an upload that finishes after done was written, and deletes its blob", async () => {
      await start();
      const putStream = blobs.putStream.bind(blobs);
      vi.spyOn(blobs, "putStream").mockImplementation(async (key, body, options) => {
        const stored = await putStream(key, body, options);
        // The default workspace upload lands while this extra's body was streaming.
        if (key === REPO_BLOB.workspace(TOKEN, "extra-alpha")) {
          await blobs.put(BLOB.done(TOKEN), Buffer.from(JSON.stringify({ workspace: "ok" })));
        }
        return stored;
      });
      const answer = await fetch(`${base}/repos/extra-alpha/workspace`, tool(upload("tar")));
      expect(answer.status).toBe(409);
      expect(await answer.json()).toEqual({ error: { type: "substrate_run_collected" } });
      expect(await blobs.head(REPO_BLOB.workspace(TOKEN, "extra-alpha"))).toBeNull();
      expect(JSON.parse((await blobs.get(BLOB.done(TOKEN))).toString())).toEqual({ workspace: "ok" });
    });

    it("still answers 409 when deleting a late upload's blob fails", async () => {
      await start();
      const putStream = blobs.putStream.bind(blobs);
      vi.spyOn(blobs, "putStream").mockImplementation(async (key, body, options) => {
        const stored = await putStream(key, body, options);
        if (key === REPO_BLOB.workspace(TOKEN, "extra-alpha")) {
          await blobs.put(BLOB.done(TOKEN), Buffer.from(JSON.stringify({ workspace: "ok" })));
        }
        return stored;
      });
      const remove = vi.spyOn(blobs, "delete").mockRejectedValue(new Error("store down"));
      const answer = await fetch(`${base}/repos/extra-alpha/workspace`, tool(upload("tar")));
      expect(answer.status).toBe(409);
      expect(await answer.json()).toEqual({ error: { type: "substrate_run_collected" } });
      expect(remove).toHaveBeenCalledWith(REPO_BLOB.workspace(TOKEN, "extra-alpha"));
      await settle();
      expect(routeLines()).toEqual([expect.objectContaining({ route: "repos.workspace", status: 409 })]);
      expect(routeLines()[0]).not.toHaveProperty("errorKind");
    });

    it("logs the repository only after auth, and only a name on the row", async () => {
      await blobs.put(REPO_BLOB.seed(TOKEN, "extra-beta"), Buffer.from("seed-beta"));
      await start();
      // Unauthenticated (bad actor JWT, then no credential at all): no repository on the line.
      const bad = { headers: { "x-wardby-actor-jwt": "Bearer bad" } };
      expect((await fetch(`${base}/repos/extra-beta/seed`, bad)).status).toBe(401);
      expect((await fetch(`${base}/repos/extra-alpha/workspace`, { ...upload("tar"), ...bad })).status).toBe(401);
      expect((await fetch(`${base}/repos/extra-beta/seed`)).status).toBe(401);
      // Authenticated but not on the row: 404, no repository.
      expect((await fetch(`${base}/repos/extra-gamma/seed`, tool())).status).toBe(404);
      expect((await fetch(`${base}/repos/extra-gamma/workspace`, tool(upload("tar")))).status).toBe(404);
      await settle();
      const refused = routeLines();
      expect(refused).toHaveLength(5);
      for (const line of refused) expect(line).not.toHaveProperty("repository");
      // Authenticated and on the row (a read one refused for upload included): the name is logged.
      expect((await fetch(`${base}/repos/extra-beta/seed`, tool())).status).toBe(200);
      expect((await fetch(`${base}/repos/extra-beta/workspace`, tool(upload("tar")))).status).toBe(404);
      await settle();
      expect(routeLines().slice(5)).toEqual([
        expect.objectContaining({ route: "repos.seed", status: 200, repository: "extra-beta" }),
        expect.objectContaining({ route: "repos.workspace", status: 404, repository: "extra-beta" }),
      ]);
    });

    it("single shape: the agent actor is the holder", async () => {
      overrides = { runLayoutForToken: async () => ({ ...LAYOUT, shape: "single" }) };
      await blobs.put(REPO_BLOB.seed(TOKEN, "extra-beta"), Buffer.from("seed-beta"));
      await start();
      expect((await fetch(`${base}/repos/extra-beta/seed`, tool())).status).toBe(401);
      expect((await fetch(`${base}/repos/extra-alpha/workspace`, tool(upload("w")))).status).toBe(401);
      expect(await blobs.head(REPO_BLOB.workspace(TOKEN, "extra-alpha"))).toBeNull();
      const seed = await fetch(`${base}/repos/extra-beta/seed`, agent());
      expect(seed.status).toBe(200);
      expect(await seed.text()).toBe("seed-beta");
      expect((await fetch(`${base}/repos/extra-alpha/workspace`, agent(upload("tar")))).status).toBe(200);
      expect((await blobs.get(REPO_BLOB.workspace(TOKEN, "extra-alpha"))).toString()).toBe("tar");
      expect(await blobs.head(BLOB.done(TOKEN))).toBeNull();
    });

    it("a run without a row or without repositories has no repository routes", async () => {
      await blobs.put(REPO_BLOB.seed(TOKEN, "extra-alpha"), Buffer.from("seed-alpha"));
      for (const layout of [undefined, { shape: "pair" as const }]) {
        overrides = { runLayoutForToken: async () => layout };
        await start();
        expect((await fetch(`${base}/repos/extra-alpha/seed`, tool())).status).toBe(404);
        expect((await fetch(`${base}/repos/extra-alpha/workspace`, tool(upload("tar")))).status).toBe(404);
        expect(await blobs.head(REPO_BLOB.workspace(TOKEN, "extra-alpha"))).toBeNull();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        });
      }
    });

    it("looks the layout up once per token", async () => {
      const lookup = vi.fn(async () => LAYOUT);
      overrides = { runLayoutForToken: lookup };
      await blobs.put(REPO_BLOB.seed(TOKEN, "extra-alpha"), Buffer.from("seed-alpha"));
      await start();
      expect((await fetch(`${base}/repos/extra-alpha/seed`, tool())).status).toBe(200);
      expect((await fetch(`${base}/repos/extra-alpha/workspace`, tool(upload("tar")))).status).toBe(200);
      expect((await fetch(`${base}/events?after=0`, tool())).status).toBe(200);
      expect(lookup).toHaveBeenCalledTimes(1);
    });

    it("logs the repository name and nothing of the body", async () => {
      await start();
      const answers: string[] = [];
      const ok = await fetch(`${base}/repos/extra-alpha/workspace`, tool(upload(CAPABILITY)));
      expect(ok.status).toBe(200);
      answers.push(await ok.text());
      const refused = await fetch(`${base}/repos/extra-beta/workspace`, tool(upload(CAPABILITY)));
      expect(refused.status).toBe(404);
      answers.push(await refused.text());
      await settle();
      const lines = routeLines();
      const line = lines.find((l) => l.route === "repos.workspace" && l.status === 200);
      expect(line).toMatchObject({ route: "repos.workspace", repository: "extra-alpha" });
      const allowed = [
        "event",
        "runToken",
        "route",
        "status",
        "bytes",
        "durationMs",
        "errorKind",
        "setupDeleted",
        "repository",
      ];
      for (const l of lines) for (const key of Object.keys(l)) expect(allowed).toContain(key);
      expect(JSON.stringify(logCalls)).not.toContain(CAPABILITY);
      expect(JSON.stringify(warnCalls)).not.toContain(CAPABILITY);
      for (const body of answers) expect(body).not.toContain(CAPABILITY);
    });

    it("the default workspace upload still ends the run after the extras", async () => {
      await start();
      expect((await fetch(`${base}/repos/extra-alpha/workspace`, tool(upload("a")))).status).toBe(200);
      expect((await fetch(`${base}/workspace`, tool(upload("w")))).status).toBe(200);
      expect(JSON.parse((await blobs.get(BLOB.done(TOKEN))).toString())).toEqual({ workspace: "ok" });
      // After done, a late extra upload is refused.
      expect((await fetch(`${base}/repos/extra-alpha/workspace`, tool(upload("late")))).status).toBe(409);
      expect((await blobs.get(REPO_BLOB.workspace(TOKEN, "extra-alpha"))).toString()).toBe("a");
    });
  });
});
