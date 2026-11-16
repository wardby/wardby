import { describe, expect, it } from "vitest";
import { createHttpTransport, fetchSandboxInput } from "./http-transport.js";
import { GatewayError, type GatewayRequest } from "./protocol.js";

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

  it("carries an internal error's cause code to the worker", async () => {
    const { fetch } = scripted([
      () =>
        json(
          {
            ok: false,
            error: {
              code: "internal",
              message: "The gateway could not serve this call (coding_execution_not_configured).",
              causeCode: "coding_execution_not_configured",
            },
          },
          500,
        ),
    ]);
    const transport = createHttpTransport({
      url: "http://gw",
      capability: "c".repeat(43),
      fetch,
      sleep: async () => {},
    });
    await expect(transport.call(request)).rejects.toMatchObject({
      code: "internal",
      causeCode: "coding_execution_not_configured",
    });
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

describe("fetchSandboxInput", () => {
  const URL_ = "http://gw:8790/native-gateway/v1/input";
  const CAP = "fake_native_capability_for_input_0001";

  it("posts to the given URL with the bearer and no body", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return json({ ok: true, result: { input: { runId: "r" } } });
    }) as unknown as typeof globalThis.fetch;
    expect(await fetchSandboxInput({ url: URL_, capability: CAP, fetch })).toEqual({ input: { runId: "r" } });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(URL_);
    expect(seen[0].init?.method).toBe("POST");
    expect(seen[0].init?.headers).toEqual({ authorization: `Bearer ${CAP}` });
    expect(seen[0].init?.body).toBeUndefined();
  });

  it("retries a connection failure, then succeeds", async () => {
    const { fetch, calls } = scripted([
      () => {
        throw new TypeError("fetch failed");
      },
      () => json({ ok: true, result: 7 }),
    ]);
    expect(await fetchSandboxInput({ url: URL_, capability: CAP, fetch, sleep: async () => {} })).toBe(7);
    expect(calls()).toBe(2);
  });

  it("retries not_ready", async () => {
    const { fetch, calls } = scripted([notReady, () => json({ ok: true, result: 8 })]);
    expect(await fetchSandboxInput({ url: URL_, capability: CAP, fetch, sleep: async () => {} })).toBe(8);
    expect(calls()).toBe(2);
  });

  it("gives up with internal once its retry window passes", async () => {
    const { fetch, calls } = scripted([
      () => {
        throw new TypeError("fetch failed");
      },
    ]);
    const err = await fetchSandboxInput({
      url: URL_,
      capability: CAP,
      fetch,
      retryForMs: 30,
      sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).code).toBe("internal");
    expect(calls()).toBeGreaterThan(1);
  });

  it("gives up at once on a 401", async () => {
    const { fetch, calls } = scripted([
      () => json({ ok: false, error: { code: "unauthorized", message: "Unknown gateway capability." } }, 401),
      () => json({ ok: true, result: 1 }),
    ]);
    const err = await fetchSandboxInput({ url: URL_, capability: CAP, fetch, sleep: async () => {} }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GatewayError);
    expect((err as GatewayError).code).toBe("unauthorized");
    expect(calls()).toBe(1);
  });
});
