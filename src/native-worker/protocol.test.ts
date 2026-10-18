import { describe, expect, it } from "vitest";
import {
  causeCodeOf,
  GatewayRequestSchema,
  MAX_MESSAGE_BYTES,
  parseMessage,
  parseParams,
  ProtocolError,
  WorkerInputSchema,
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
