import type { AddressInfo } from "node:net";
import { request, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { capabilityHash } from "../../providers/coding-proxy/capability-hash.js";
import {
  handleRunStepPost,
  MAX_INGRESS_CONNECTIONS,
  parseRunStepsListen,
  startRunStepIngress,
  type RunStepIngressDeps,
} from "./ingress.js";
import { MAX_RUN_STEPS_POST_BYTES, RUN_STEPS_INGRESS_PATH, type RunStepBatch, type RunStepSink } from "./types.js";

// Fake values only: never a real credential.
const CAP = `rrp_${"B".repeat(43)}`;
const OTHER_CAP = `rrp_${"Z".repeat(43)}`;
const FAKE_SECRET = "wbFake-Secret-Value-7f3a91";
const NOW = new Date("2026-11-07T12:00:00.000Z");
const batch: RunStepBatch = {
  steps: [{ kind: "tool", callId: "c1", tool: "Bash", text: "npm test", truncated: false }],
  results: [{ callId: "c0", status: "exit 1" }],
};
/** A POST body: the batch with the run it is for. */
const postBody = (value: Record<string, unknown> = { ...batch }, runId = "r1") => JSON.stringify({ runId, ...value });

function deps(
  session: { runId: string; deadlineAt: Date } | null = { runId: "r1", deadlineAt: new Date(NOW.getTime() + 60_000) },
  opts: { lookupError?: Error; record?: RunStepSink["record"]; requestTimeoutMs?: number } = {},
) {
  const findUnique = vi.fn(async ({ where }: { where: { capabilityHash: string } }) => {
    if (opts.lookupError) throw opts.lookupError;
    return where.capabilityHash === capabilityHash(CAP) ? session : null;
  });
  const record = vi.fn(opts.record ?? (async (_runId: string, _batch: RunStepBatch, _extra?: readonly string[]) => {}));
  const sink: RunStepSink = { record };
  const value: RunStepIngressDeps = {
    db: { codingProxySession: { findUnique } } as never,
    sink,
    now: () => NOW,
    ...(opts.requestTimeoutMs ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
  };
  return { value, record };
}

describe("handleRunStepPost", () => {
  it("records a valid batch for the capability's run, with the capability as a value to redact", async () => {
    const d = deps();
    expect(await handleRunStepPost(d.value, `Bearer ${CAP}`, postBody())).toEqual({ status: 202, body: { ok: true } });
    expect(d.record).toHaveBeenCalledWith("r1", batch, [CAP]);
  });

  it("refuses a batch naming another run than the capability's, recording nothing", async () => {
    const d = deps();
    expect(await handleRunStepPost(d.value, `Bearer ${CAP}`, postBody({ ...batch }, "r2"))).toEqual({
      status: 403,
      body: { error: "run_mismatch" },
    });
    expect(d.record).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "Bearer", `Basic ${CAP}`, "Bearer rrp_short", `Bearer rrg_${"B".repeat(43)}`])(
    "refuses %j as unauthorized",
    async (authorization) => {
      const d = deps();
      expect(await handleRunStepPost(d.value, authorization, postBody())).toEqual({
        status: 401,
        body: { error: "unauthorized" },
      });
      expect(d.record).not.toHaveBeenCalled();
    },
  );

  it("refuses an unknown capability, and a session past its deadline and the grace", async () => {
    expect((await handleRunStepPost(deps(null).value, `Bearer ${CAP}`, postBody())).status).toBe(401);
    const ended = deps({ runId: "r1", deadlineAt: new Date(NOW.getTime() - 11 * 60_000) });
    expect(await handleRunStepPost(ended.value, `Bearer ${CAP}`, postBody())).toEqual({
      status: 403,
      body: { error: "session_ended" },
    });
    expect(ended.record).not.toHaveBeenCalled();
    const graced = deps({ runId: "r1", deadlineAt: new Date(NOW.getTime() - 60_000) });
    expect((await handleRunStepPost(graced.value, `Bearer ${CAP}`, postBody())).status).toBe(202);
  });

  it.each([
    ["not json", "{"],
    ["no runId", JSON.stringify(batch)],
    ["an unknown key", postBody({ ...batch, extra: 1 })],
    ["free text in a status", postBody({ steps: [], results: [{ callId: "c1", status: `exit 1 ${FAKE_SECRET}` }] })],
    ["a tool name with spaces", postBody({ steps: [{ ...batch.steps[0], tool: "rm -rf" }], results: [] })],
    ["too many steps", postBody({ steps: Array.from({ length: 65 }, () => batch.steps[0]), results: [] })],
    ["over-long text", postBody({ steps: [{ ...batch.steps[0], text: "x".repeat(16 * 1024 + 1) }], results: [] })],
  ])("refuses %s, recording nothing", async (_name, body) => {
    const d = deps();
    const response = await handleRunStepPost(d.value, `Bearer ${CAP}`, body);
    expect(response.status).toBe(400);
    expect(JSON.stringify(response)).not.toContain(FAKE_SECRET);
    expect(d.record).not.toHaveBeenCalled();
  });

  it("never puts the capability or step text in a response", async () => {
    const d = deps();
    const withSecret = postBody({ steps: [{ ...batch.steps[0], text: `echo ${FAKE_SECRET} ${CAP}` }], results: [] });
    const responses = [
      await handleRunStepPost(d.value, `Bearer ${CAP}`, withSecret),
      await handleRunStepPost(d.value, `Bearer ${CAP}`, postBody({ ...batch }, "r2")),
      await handleRunStepPost(d.value, `Bearer ${CAP}`, `{${FAKE_SECRET}`),
      await handleRunStepPost(deps(null).value, `Bearer ${CAP}`, withSecret),
    ];
    for (const value of [CAP, FAKE_SECRET]) expect(JSON.stringify(responses)).not.toContain(value);
  });
});

describe("parseRunStepsListen", () => {
  it("reads host:port or :port, and refuses anything else naming the variable", () => {
    expect(parseRunStepsListen(undefined)).toBeUndefined();
    expect(parseRunStepsListen(" ")).toBeUndefined();
    expect(parseRunStepsListen("0.0.0.0:8792")).toEqual({ host: "0.0.0.0", port: 8792 });
    expect(parseRunStepsListen(":8792")).toEqual({ host: "0.0.0.0", port: 8792 });
    for (const bad of ["8792", "host:0", "host:70000", "host:x"]) {
      expect(() => parseRunStepsListen(bad)).toThrow("WARDBY_RUN_STEPS_LISTEN must be host:port or :port");
    }
  });
});

/**
 * A POST whose body is sent in part and never ended: resolves with the answer, so a refusal that
 * comes back proves the listener answered without waiting for (or reading) the body.
 */
function openPost(port: number, authorization: string | undefined, chunk: string) {
  return new Promise<{ status: number | undefined; connection: string | undefined; text: string }>(
    (resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: RUN_STEPS_INGRESS_PATH,
          headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (part: string) => (text += part));
          res.on("end", () => resolve({ status: res.statusCode, connection: res.headers.connection, text }));
          res.on("error", () => resolve({ status: res.statusCode, connection: res.headers.connection, text }));
        },
      );
      // The listener closes the socket after a refusal: the unfinished upload may then see a reset.
      req.on("error", (err) => (req.destroyed ? undefined : reject(err)));
      req.write(chunk);
    },
  );
}

describe("startRunStepIngress", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
  });

  async function start(d: ReturnType<typeof deps>) {
    const warn = vi.fn();
    const server = await startRunStepIngress({ host: "127.0.0.1", port: 0 }, { ...d.value, log: { warn } });
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const post = (path: string, body: string, authorization = `Bearer ${CAP}`) =>
      fetch(`${base}${path}`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body,
      });
    return { base, port, post, warn };
  }

  it("caps open connections and closes the connection after a 404", async () => {
    const d = deps();
    const { base, post } = await start(d);
    expect(servers[0].maxConnections).toBe(MAX_INGRESS_CONNECTIONS);
    expect(MAX_INGRESS_CONNECTIONS).toBe(64);
    const response = await post("/mcp", postBody());
    expect(response.status).toBe(404);
    expect(response.headers.get("connection")).toBe("close");
    expect((await fetch(`${base}/`)).headers.get("connection")).toBe("close");
  });

  it.each([
    ["a malformed token", `Bearer ${FAKE_SECRET}`, 401, "unauthorized"],
    ["no Authorization", undefined, 401, "unauthorized"],
    ["an unknown capability", `Bearer ${OTHER_CAP}`, 401, "unauthorized"],
  ])(
    "refuses %s from the headers, without reading a body that never ends",
    async (_name, authorization, status, code) => {
      const d = deps();
      const { port, warn } = await start(d);
      const answer = await openPost(port, authorization, `{"runId":"r1","steps":[{"text":"${FAKE_SECRET} ${CAP}`);
      expect(answer).toEqual({ status, connection: "close", text: JSON.stringify({ error: code }) });
      expect(d.record).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it("refuses an ended session from the headers, without reading a body that never ends", async () => {
    const d = deps({ runId: "r1", deadlineAt: new Date(NOW.getTime() - 11 * 60_000) });
    const { port, warn } = await start(d);
    const answer = await openPost(port, `Bearer ${CAP}`, `{"runId":"r1","steps":[{"text":"${FAKE_SECRET}`);
    expect(answer).toEqual({ status: 403, connection: "close", text: '{"error":"session_ended"}' });
    expect(d.record).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("serves POST /internal/run-steps only", async () => {
    const d = deps();
    const { base, post, warn } = await start(d);
    expect((await post(RUN_STEPS_INGRESS_PATH, postBody())).status).toBe(202);
    expect((await post("/mcp", postBody())).status).toBe(404);
    expect((await post(`${RUN_STEPS_INGRESS_PATH}?x=1`, postBody())).status).toBe(404);
    expect((await fetch(`${base}${RUN_STEPS_INGRESS_PATH}`)).status).toBe(404);
    expect(d.record).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it("refuses a body declared over MAX_RUN_STEPS_POST_BYTES with 413, before reading it", async () => {
    const d = deps();
    const { port, warn } = await start(d);
    // Only the headers are sent: the answer comes from the declared length, so no upload races it.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: RUN_STEPS_INGRESS_PATH,
          headers: {
            authorization: `Bearer ${CAP}`,
            "content-type": "application/json",
            "content-length": String(MAX_RUN_STEPS_POST_BYTES + 1),
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode);
          req.destroy();
        },
      );
      req.on("error", reject);
      req.flushHeaders();
    });
    expect(status).toBe(413);
    expect(d.record).not.toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toEqual({ event: "run_steps_ingress_failed", status: 413, errorName: "Error" });
  });

  it("accepts a body of exactly MAX_RUN_STEPS_POST_BYTES (the forwarder's bound)", async () => {
    const d = deps();
    const { post } = await start(d);
    // Pad with JSON whitespace so the body parses: exactly the cap, never over.
    const body = postBody();
    const padded = body + " ".repeat(MAX_RUN_STEPS_POST_BYTES - Buffer.byteLength(body));
    expect(Buffer.byteLength(padded)).toBe(MAX_RUN_STEPS_POST_BYTES);
    expect((await post(RUN_STEPS_INGRESS_PATH, padded)).status).toBe(202);
  });

  it("logs nothing and answers fixed text for a batch holding a secret and a capability", async () => {
    const d = deps();
    const { post, warn } = await start(d);
    const body = postBody({
      steps: [
        { kind: "said", callId: "said:m1:0", text: `use ${FAKE_SECRET} and ${CAP} ${OTHER_CAP}`, truncated: false },
      ],
      results: [],
    });
    const response = await post(RUN_STEPS_INGRESS_PATH, body);
    expect(response.status).toBe(202);
    expect(await response.text()).toBe('{"ok":true}');
    expect(warn).not.toHaveBeenCalled();
  });

  it("refuses a wrong capability with 401 and logs nothing of the Authorization value", async () => {
    const d = deps();
    const { post, warn } = await start(d);
    const response = await post(RUN_STEPS_INGRESS_PATH, postBody(), `Bearer ${OTHER_CAP}`);
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('{"error":"unauthorized"}');
    const malformed = await post(RUN_STEPS_INGRESS_PATH, postBody(), `Bearer ${FAKE_SECRET}`);
    expect(malformed.status).toBe(401);
    expect(warn).not.toHaveBeenCalled();
    expect(d.record).not.toHaveBeenCalled();
  });

  it("keeps the capability out of the log line and the response when a lookup failure quotes it", async () => {
    const d = deps(undefined, { lookupError: new Error(`session lookup failed for ${CAP}`) });
    const { post, warn } = await start(d);
    const response = await post(RUN_STEPS_INGRESS_PATH, postBody());
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"error":"internal"}');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toEqual({ event: "run_steps_ingress_failed", status: 500, errorName: "Error" });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(CAP);
    expect(d.record).not.toHaveBeenCalled();
  });

  it("answers a fixed code when the writer fails with an error quoting the step text and the capability", async () => {
    const d = deps(undefined, {
      record: async () => {
        throw new TypeError(`write failed: ${FAKE_SECRET} ${CAP}`);
      },
    });
    const { post, warn } = await start(d);
    const body = postBody({
      steps: [{ kind: "said", callId: "said:m1:0", text: `use ${FAKE_SECRET}`, truncated: false }],
      results: [],
    });
    const response = await post(RUN_STEPS_INGRESS_PATH, body);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('{"error":"internal"}');
    expect(warn.mock.calls).toEqual([
      [{ event: "run_steps_ingress_failed", status: 500, errorName: "TypeError" }, "run steps request failed"],
    ]);
  });

  it("answers 503 timeout when a request takes longer than its limit", async () => {
    const d = deps(undefined, { record: () => new Promise(() => {}), requestTimeoutMs: 50 });
    const { post, warn } = await start(d);
    const response = await post(RUN_STEPS_INGRESS_PATH, postBody());
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"error":"timeout"}');
    expect(warn.mock.calls[0][0]).toEqual({
      event: "run_steps_ingress_failed",
      status: 503,
      errorName: "TimeoutError",
    });
  });

  it("logs a write failing after the timeout answer by its name only", async () => {
    const d = deps(undefined, {
      record: () =>
        new Promise((_, reject) => setTimeout(() => reject(new TypeError(`late: ${FAKE_SECRET} ${CAP}`)), 150)),
      requestTimeoutMs: 30,
    });
    const { post, warn } = await start(d);
    const body = postBody({
      steps: [{ kind: "said", callId: "said:m1:0", text: `use ${FAKE_SECRET}`, truncated: false }],
      results: [],
    });
    const response = await post(RUN_STEPS_INGRESS_PATH, body);
    expect(response.status).toBe(503);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(2), { timeout: 2_000 });
    expect(warn.mock.calls[1][0]).toEqual({ event: "run_steps_ingress_late_failure", errorName: "TypeError" });
    for (const value of [CAP, FAKE_SECRET]) expect(JSON.stringify(warn.mock.calls)).not.toContain(value);
  });
});
