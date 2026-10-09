import { describe, expect, it } from "vitest";
import { createHttpTransport } from "./http-transport.js";
import type { GatewayRequest } from "./protocol.js";

const request = { v: 1, runId: "r", callId: "c-1", method: "llm.countTokens", params: {} } as unknown as GatewayRequest;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const notReady = () => json({ ok: false, error: { code: "not_ready", message: "not proven yet" } }, 503);

function scripted(responses: Array<() => Response>) {
  let calls = 0;
  const fetch = (async () => responses[Math.min(calls++, responses.length - 1)]()) as typeof globalThis.fetch;
  return { fetch, calls: () => calls };
}

describe("createHttpTransport", () => {
  it("waits out not_ready, asking again with the same request until the gateway serves it", async () => {
    const { fetch, calls } = scripted([notReady, notReady, () => json({ ok: true, result: 42 })]);
    const transport = createHttpTransport({
      url: "http://gw",
      capability: "c".repeat(43),
      fetch,
      sleep: async () => {},
    });
    expect(await transport.call(request)).toBe(42);
    expect(calls()).toBe(3);
  });

  it("does the same for a model stream, which reserves nothing until it is served", async () => {
    const ndjson = () =>
      new Response(`${JSON.stringify({ event: { type: "text", delta: "hi" } })}\n${JSON.stringify({ end: true })}\n`, {
        headers: { "content-type": "application/x-ndjson" },
      });
    const { fetch } = scripted([notReady, ndjson]);
    const transport = createHttpTransport({
      url: "http://gw",
      capability: "c".repeat(43),
      fetch,
      sleep: async () => {},
    });
    const events = [];
    for await (const event of transport.stream(request)) events.push(event);
    expect(events).toEqual([{ type: "text", delta: "hi" }]);
  });

  it("gives up on not_ready once its retry window passes", async () => {
    const { fetch } = scripted([notReady]);
    const transport = createHttpTransport({
      url: "http://gw",
      capability: "c".repeat(43),
      fetch,
      sleep: async () => {},
      retryForMs: 0,
    });
    await expect(transport.call(request)).rejects.toMatchObject({ code: "not_ready" });
  });

  it("never retries other refusals", async () => {
    const { fetch, calls } = scripted([() => json({ ok: false, error: { code: "not_allowed", message: "no" } }, 403)]);
    const transport = createHttpTransport({
      url: "http://gw",
      capability: "c".repeat(43),
      fetch,
      sleep: async () => {},
    });
    await expect(transport.call(request)).rejects.toMatchObject({ code: "not_allowed" });
    expect(calls()).toBe(1);
  });
});
