import { describe, expect, it } from "vitest";
import {
  CAPABILITY_HEADER_ENV,
  INJECTED_CAPABILITY_PLACEHOLDER,
  REGISTRY_TOKEN_ENV,
  readWorkerCredentials,
} from "./credentials.js";

const TOKEN = `rrg_${"F".repeat(43)}`;
const REAL_CAPABILITY = `rrp_${"R".repeat(43)}`;

function thrown(env: NodeJS.ProcessEnv): unknown {
  try {
    readWorkerCredentials(env);
  } catch (error) {
    return error;
  }
  throw new Error("expected readWorkerCredentials to throw");
}

describe("readWorkerCredentials", () => {
  it("needs the run capability, with today's message", () => {
    expect(() => readWorkerCredentials({})).toThrow("wardby_run_capability_missing");
    expect(() => readWorkerCredentials({ WARDBY_RUN_CAPABILITY: "" })).toThrow("wardby_run_capability_missing");
  });

  it("without the new variables returns exactly { capability }, as today", () => {
    expect(readWorkerCredentials({ WARDBY_RUN_CAPABILITY: REAL_CAPABILITY })).toStrictEqual({
      capability: REAL_CAPABILITY,
    });
  });

  it("header mode returns the placeholder, the header, and the given token", () => {
    expect(
      readWorkerCredentials({
        WARDBY_RUN_CAPABILITY: INJECTED_CAPABILITY_PLACEHOLDER,
        [CAPABILITY_HEADER_ENV]: "x-api-key",
        [REGISTRY_TOKEN_ENV]: TOKEN,
      }),
    ).toStrictEqual({
      capability: INJECTED_CAPABILITY_PLACEHOLDER,
      capabilityHeader: "x-api-key",
      registryToken: TOKEN,
    });
  });

  const invalid: [string, NodeJS.ProcessEnv][] = [
    [
      "the header without a token",
      { WARDBY_RUN_CAPABILITY: INJECTED_CAPABILITY_PLACEHOLDER, [CAPABILITY_HEADER_ENV]: "x-api-key" },
    ],
    [
      "a token without the header",
      { WARDBY_RUN_CAPABILITY: INJECTED_CAPABILITY_PLACEHOLDER, [REGISTRY_TOKEN_ENV]: TOKEN },
    ],
    [
      "the header with a real (non-placeholder) capability",
      { WARDBY_RUN_CAPABILITY: REAL_CAPABILITY, [CAPABILITY_HEADER_ENV]: "x-api-key", [REGISTRY_TOKEN_ENV]: TOKEN },
    ],
    [
      "a token of the wrong shape",
      {
        WARDBY_RUN_CAPABILITY: INJECTED_CAPABILITY_PLACEHOLDER,
        [CAPABILITY_HEADER_ENV]: "x-api-key",
        [REGISTRY_TOKEN_ENV]: "rrg_short",
      },
    ],
    [
      "another header",
      {
        WARDBY_RUN_CAPABILITY: INJECTED_CAPABILITY_PLACEHOLDER,
        [CAPABILITY_HEADER_ENV]: "authorization",
        [REGISTRY_TOKEN_ENV]: TOKEN,
      },
    ],
    [
      "an empty header",
      {
        WARDBY_RUN_CAPABILITY: INJECTED_CAPABILITY_PLACEHOLDER,
        [CAPABILITY_HEADER_ENV]: "",
        [REGISTRY_TOKEN_ENV]: TOKEN,
      },
    ],
  ];
  it.each(invalid)("throws worker_credentials_invalid for %s, naming no value", (_name, env) => {
    const error = thrown(env);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("worker_credentials_invalid");
    expect(String(error)).not.toContain(TOKEN);
    expect(String(error)).not.toContain("rrg_short");
    expect(String(error)).not.toContain(REAL_CAPABILITY);
    expect(String(error)).not.toContain(INJECTED_CAPABILITY_PLACEHOLDER);
  });
});
