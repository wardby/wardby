import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LlmStreamEvent } from "../providers/llm/types.js";

// Obviously fake, and code-shaped on purpose: a token like this passes causeCodeOf on its own.
const FAKE_READABLE = "fake_readable_secret_0004";

const streamFailure = vi.hoisted(() => ({
  error: undefined as unknown as Error,
  handlerThrows: undefined as Error | undefined,
}));
vi.mock("./gateway-server.js", () => ({
  serveGatewayRequest: async () => {
    if (streamFailure.handlerThrows) throw streamFailure.handlerThrows;
    return {
      kind: "stream",
      status: 200,
      // eslint-disable-next-line require-yield
      events: (async function* (): AsyncIterable<LlmStreamEvent> {
        throw streamFailure.error;
      })(),
    };
  },
}));

const { createGatewayServer, httpLog, NATIVE_GATEWAY_PATH } = await import("./http-server.js");
const { GATEWAY_INTERNAL_MESSAGE, GatewayError } = await import("./protocol.js");

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  streamFailure.handlerThrows = undefined;
});

/** The last ndjson frame the listener sends for a model stream that fails with `err`. */
async function streamErrorFrame(err: Error): Promise<{ error: Record<string, unknown> }> {
  streamFailure.error = err;
  const server = createGatewayServer({} as never);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  close = () => new Promise<void>((done) => server.close(() => done()));
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}${NATIVE_GATEWAY_PATH}`, { method: "POST", body: "{}" });
  const lines = (await response.text()).trim().split("\n");
  return JSON.parse(lines[lines.length - 1]) as { error: Record<string, unknown> };
}

describe("native gateway HTTP listener, model stream failures", () => {
  it("never sends an unexpected error's own text", async () => {
    const frame = await streamErrorFrame(new Error(`${FAKE_READABLE}: raw exception text`));
    expect({
      keys: Object.keys(frame.error).sort(),
      code: frame.error.code,
      generic: frame.error.message === GATEWAY_INTERNAL_MESSAGE,
      leaks: JSON.stringify(frame).includes(FAKE_READABLE),
    }).toEqual({ keys: ["code", "message"], code: "internal", generic: true, leaks: false });
  });

  it("carries a checked cause code from the gateway", async () => {
    const frame = await streamErrorFrame(
      new GatewayError("internal", GATEWAY_INTERNAL_MESSAGE, "coding_execution_not_configured"),
    );
    expect(frame.error).toEqual({
      code: "internal",
      message: GATEWAY_INTERNAL_MESSAGE,
      causeCode: "coding_execution_not_configured",
    });
  });
});

describe("native gateway HTTP listener, handler failures", () => {
  it("logs only the error's name and declared code, never its text", async () => {
    streamFailure.handlerThrows = new Error(`${FAKE_READABLE}: raw handler text`);
    const lines: unknown[] = [];
    const spy = vi.spyOn(httpLog, "error").mockImplementation((obj: unknown) => {
      lines.push(obj);
    });
    try {
      const server = createGatewayServer({} as never);
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      close = () => new Promise<void>((done) => server.close(() => done()));
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}${NATIVE_GATEWAY_PATH}`, { method: "POST", body: "{}" });
      expect(response.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(inspect(lines, { depth: 10 }).includes(FAKE_READABLE)).toBe(false);
    expect(lines).toEqual([{ errName: "Error", causeCode: undefined }]);
  });
});
