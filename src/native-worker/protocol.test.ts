import { describe, expect, it } from "vitest";
import {
  causeCodeOf,
  GATEWAY_INTERNAL_MESSAGE,
  GatewayError,
  GatewayRequestSchema,
  MAX_MESSAGE_BYTES,
  parseMessage,
  parseParams,
  ProtocolError,
  toGatewayError,
  WorkerInputSchema,
  workerGatewayError,
  type WorkerInput,
} from "./protocol.js";

const input: WorkerInput = {
  v: 1,
  runId: "run_1",
  agent: { systemPrompt: "sys", model: "claude-haiku-4-5", budgetUsd: 0.5, maxTurns: 4 },
  tools: [{ name: "double", description: "d", jsonSchema: { type: "object" } }],
  builtinTools: ["memory_get"],
  userTools: { double: { code: "return params.n * 2;", paramsZod: "z.object({ n: z.number() })" } },
  runsConcurrently: [],
  pricing: {
    provider: "anthropic",
    modelId: "claude-haiku-4-5",
    encoding: "cl100k_base",
    inputPerMTok: 1,
    outputPerMTok: 5,
    cachedInputPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
    efforts: [],
    thinkingMode: "none",
  },
};

describe("native worker protocol", () => {
  it("round-trips the worker input", () => {
    expect(parseMessage(JSON.stringify(input), WorkerInputSchema)).toEqual(input);
  });

  it("rejects an unknown protocol version before anything else", () => {
    expect(() => parseMessage(JSON.stringify({ ...input, v: 2 }), WorkerInputSchema)).toThrow(
      expect.objectContaining({ code: "unsupported_protocol_version" }),
    );
  });

  it("cannot carry a user tool's capabilities or secret names to the worker", () => {
    const withSecrets = {
      ...input,
      userTools: { double: { ...input.userTools.double, allowedSecrets: ["API_KEY"] } },
    };
    expect(() => parseMessage(JSON.stringify(withSecrets), WorkerInputSchema)).toThrow(
      expect.objectContaining({ code: "message_invalid" }),
    );
  });

  it("rejects unknown fields, non-JSON, and oversized messages", () => {
    expect(() => parseMessage(JSON.stringify({ ...input, extra: 1 }), WorkerInputSchema)).toThrow(ProtocolError);
    expect(() => parseMessage("{not json", WorkerInputSchema)).toThrow(
      expect.objectContaining({ code: "message_not_json" }),
    );
    expect(() => parseMessage("x".repeat(MAX_MESSAGE_BYTES + 1), WorkerInputSchema)).toThrow(
      expect.objectContaining({ code: "message_too_large" }),
    );
  });

  it("validates each request envelope and its method's params", () => {
    const request = {
      v: 1,
      runId: "run_1",
      callId: "c1",
      method: "host.call",
      params: { tool: "double", invocation: "t1", bridge: "__bridge_datastoreGet", argsJson: '["k"]' },
    };
    const parsed = parseMessage(JSON.stringify(request), GatewayRequestSchema);
    expect(parseParams("host.call", parsed.params)).toEqual(request.params);
    expect(() => parseMessage(JSON.stringify({ ...request, method: "db.query" }), GatewayRequestSchema)).toThrow(
      ProtocolError,
    );
    expect(() => parseParams("finish", { status: "succeeded", finalText: "", turns: 1, usage: {} })).toThrow(
      expect.objectContaining({ code: "message_invalid" }),
    );
  });

  it("does not let the worker report usage in its terminal result", () => {
    // The gateway's own metering is authoritative; a usage field is refused outright.
    expect(() =>
      parseParams("finish", {
        status: "succeeded",
        finalText: "ok",
        turns: 1,
        usage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
      }),
    ).toThrow(ProtocolError);
    expect(parseParams("finish", { status: "succeeded", finalText: "ok", turns: 1 })).toEqual({
      status: "succeeded",
      finalText: "ok",
      turns: 1,
    });
  });
});

describe("causeCodeOf", () => {
  it("accepts a snake_case code with an underscore, bare or followed by a colon", () => {
    expect(causeCodeOf(new Error("coding_execution_not_configured"))).toBe("coding_execution_not_configured");
    expect(causeCodeOf(new Error("coding_execution_not_configured: details here"))).toBe(
      "coding_execution_not_configured",
    );
  });

  it("gives no code to a bare word or a code with no underscore", () => {
    expect(causeCodeOf(new Error("abc123token"))).toBeUndefined();
    expect(causeCodeOf(new Error("x: y"))).toBeUndefined();
    expect(causeCodeOf("plainword")).toBeUndefined();
  });
});

// Obviously fake, and code-shaped on purpose: a token like this passes causeCodeOf on its own.
const FAKE_READABLE = "fake_readable_secret_0001";
const secrets =
  (...values: string[]) =>
  async () =>
    values;
/** What a test may print about an error that could hold the fake value: booleans and fixed codes only. */
const shape = (err: GatewayError) => ({
  code: err.code,
  generic: err.message === GATEWAY_INTERNAL_MESSAGE,
  hasCauseCode: err.causeCode !== undefined,
  leaks: JSON.stringify({ ...err, message: err.message }).includes(FAKE_READABLE),
});
const SAFE_INTERNAL = { code: "internal", generic: true, hasCauseCode: false, leaks: false };

describe("workerGatewayError", () => {
  it("drops a cause code equal to a secret value the run can read", async () => {
    const err = await workerGatewayError(new Error(FAKE_READABLE), secrets(FAKE_READABLE));
    expect(shape(err)).toEqual(SAFE_INTERNAL);
  });

  it("drops a cause code that contains, or is contained in, a secret value", async () => {
    const contains = await workerGatewayError(new Error(`x_${FAKE_READABLE}: detail`), secrets(FAKE_READABLE));
    expect(shape(contains)).toEqual(SAFE_INTERNAL);
    const containedIn = await workerGatewayError(new Error("readable_secret: detail"), secrets(FAKE_READABLE));
    expect(shape(containedIn)).toEqual(SAFE_INTERNAL);
  });

  it("passes a normal code, with the generic message naming it", async () => {
    const err = await workerGatewayError(
      new Error("coding_execution_not_configured: detail-that-stays"),
      secrets(FAKE_READABLE),
    );
    expect(err.causeCode).toBe("coding_execution_not_configured");
    expect(err.message).toBe("The gateway could not serve this call (coding_execution_not_configured).");
    expect(err.message).not.toContain("detail-that-stays");
  });

  it("ignores a secret value below the redactor's minimum length, as the redactor does", async () => {
    const err = await workerGatewayError(new Error("ab_cd"), secrets("ab_cd"));
    expect(err.causeCode).toBe("ab_cd");
  });

  it("sends no cause code it could not check", async () => {
    expect((await workerGatewayError(new Error("coding_execution_not_configured"))).causeCode).toBeUndefined();
    const failing = async (): Promise<string[]> => Promise.reject(new Error("secret store down"));
    expect((await workerGatewayError(new Error("coding_execution_not_configured"), failing)).causeCode).toBeUndefined();
  });

  it("checks a GatewayError's cause code too, keeping its code and message", async () => {
    const err = await workerGatewayError(
      new GatewayError("internal", "fixed text", FAKE_READABLE),
      secrets(FAKE_READABLE),
    );
    expect({ ...shape(err), message: err.message }).toEqual({
      ...SAFE_INTERNAL,
      generic: false,
      message: "fixed text",
    });
  });
});

describe("toGatewayError", () => {
  it("carries only the generic message for an unexpected error, never its text or an unchecked code", () => {
    const err = toGatewayError(new Error(`${FAKE_READABLE}: raw detail`));
    expect(shape(err)).toEqual(SAFE_INTERNAL);
  });

  it("passes a GatewayError as it is", () => {
    const err = toGatewayError(new GatewayError("internal", GATEWAY_INTERNAL_MESSAGE, "checked_code"));
    expect(err).toMatchObject({ code: "internal", message: GATEWAY_INTERNAL_MESSAGE, causeCode: "checked_code" });
  });
});
