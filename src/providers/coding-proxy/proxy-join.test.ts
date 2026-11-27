import { afterEach, describe, expect, it, vi } from "vitest";
import { setLogLineFilter } from "../../core/logger.js";
import { RUN_JOIN_POLL_PATH } from "../../core/run-steps/types.js";
import type { ModelPricing } from "../llm/pricing-core.js";
import { MemoryProxyLedger } from "./memory-ledger.js";
import { CodingProxy } from "./proxy.js";
import { JOIN_POLL_PATH, startCodingProxyServer } from "./server.js";

// Trace level for this file, so a log line below info is captured by the no-logging test.
vi.hoisted(() => {
  process.env.LOG_LEVEL = "trace";
});

const NOW = new Date("2026-11-27T12:00:00.000Z");
const PRICE: ModelPricing = {
  encoding: "o200k_base",
  inputPerMTok: 1,
  cachedInputPerMTok: 0.1,
  cacheWritePerMTok: 2,
  outputPerMTok: 4,
};
// Fake values only: never a real credential.
const FAKE_MESSAGE = "wbFake-Joined-Message-91c2";

afterEach(() => vi.restoreAllMocks());

async function harness(join?: { fetch: typeof fetch } | null) {
  const upstream = vi.fn<typeof fetch>();
  const proxy = new CodingProxy({
    ledger: new MemoryProxyLedger({ now: () => NOW }),
    credentials: { resolve: async () => "UPSTREAM_SECRET" },
    fetch: vi.fn(async () => new Response("{}")),
    now: () => NOW,
    pricing: () => PRICE,
    pricingVersion: "test-v1",
    ...(join === null ? {} : { join: { url: "http://control-plane:8788", fetch: join?.fetch ?? upstream } }),
  });
  const session = await proxy.createSession({
    runId: "run-join-1",
    credentialRef: "anthropic/project-a",
    protocol: "anthropic-messages",
    allowedModels: ["claude-sonnet-5"],
    deadlineAt: new Date(NOW.getTime() + 60_000),
    budgetUsd: 1,
  });
  return { proxy, session, upstream };
}

const answer = { joined: true, messages: [{ seq: 3, text: FAKE_MESSAGE, interrupt: false }] };

describe("CodingProxy.joinPoll", () => {
  it("relays the poll to the control plane with the run capability and returns its answer", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(answer));
    const h = await harness({ fetch: fetchImpl });
    await expect(h.proxy.joinPoll(h.session.capability, JSON.stringify({ after: 2, joined: false }))).resolves.toEqual(
      answer,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://control-plane:8788${RUN_JOIN_POLL_PATH}`);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${h.session.capability}`);
    expect(JSON.parse(init.body as string)).toEqual({ after: 2, joined: false });
  });

  it("answers join_unavailable without a control-plane URL", async () => {
    const h = await harness(null);
    await expect(
      h.proxy.joinPoll(h.session.capability, JSON.stringify({ after: 0, joined: false })),
    ).rejects.toMatchObject({ status: 404, code: "join_unavailable" });
  });

  it("refuses a bad capability or a body outside the schema, without calling the control plane", async () => {
    const h = await harness();
    await expect(h.proxy.joinPoll("rrp_wrong", JSON.stringify({ after: 0, joined: false }))).rejects.toMatchObject({
      status: 401,
    });
    for (const body of [
      "not json",
      JSON.stringify({ after: -1, joined: false }),
      JSON.stringify({ after: 0 }),
      JSON.stringify({ after: 0, joined: false, extra: 1 }),
    ]) {
      await expect(h.proxy.joinPoll(h.session.capability, body)).rejects.toMatchObject({
        status: 400,
        code: "invalid_join_poll",
      });
    }
    expect(h.upstream).not.toHaveBeenCalled();
  });

  it("turns control-plane failures and malformed answers into fixed codes", async () => {
    const cases: Array<[() => Promise<Response>, number, string]> = [
      [async () => Response.json({ error: "session_ended" }, { status: 403 }), 403, "join_refused"],
      [async () => Response.json({ error: "unauthorized" }, { status: 401 }), 401, "join_refused"],
      [async () => new Response("oops", { status: 500 }), 502, "join_unavailable"],
      [async () => Response.json({ joined: "yes", messages: [] }), 502, "join_unavailable"],
      [async () => new Response("not json"), 502, "join_unavailable"],
      [
        async () => {
          throw new Error(`connect failed ${FAKE_MESSAGE}`);
        },
        502,
        "join_unavailable",
      ],
    ];
    for (const [reply, status, code] of cases) {
      const h = await harness({ fetch: vi.fn<typeof fetch>(reply) });
      const failure = await h.proxy
        .joinPoll(h.session.capability, JSON.stringify({ after: 0, joined: false }))
        .catch((e: unknown) => e);
      expect(failure).toMatchObject({ status, code });
      expect(String((failure as Error).message)).not.toContain(FAKE_MESSAGE);
    }
  });
});

describe("join poll route", () => {
  it("serves the answer over HTTP and logs no message text", async () => {
    const lines: string[] = [];
    setLogLineFilter((line) => {
      lines.push(line);
      return "";
    });
    try {
      const h = await harness({ fetch: vi.fn<typeof fetch>(async () => Response.json(answer)) });
      const server = await startCodingProxyServer(h.proxy, { host: "127.0.0.1", port: 0 });
      try {
        const post = (headers: Record<string, string>, body: string, method = "POST") =>
          fetch(`http://127.0.0.1:${server.port}${JOIN_POLL_PATH}`, {
            method,
            headers,
            ...(method === "POST" ? { body } : {}),
          });
        const ok = await post(
          { "content-type": "application/json", "x-api-key": h.session.capability },
          JSON.stringify({ after: 0, joined: false }),
        );
        expect(ok.status).toBe(200);
        expect(await ok.json()).toEqual(answer);
        expect((await post({ "x-api-key": h.session.capability }, "{}", "GET")).status).toBe(405);
        expect((await post({ "content-type": "text/plain", "x-api-key": h.session.capability }, "{}")).status).toBe(
          415,
        );
      } finally {
        await server.close();
      }
      expect(lines.join("\n")).not.toContain(FAKE_MESSAGE);
    } finally {
      setLogLineFilter((line) => line);
    }
  });
});
