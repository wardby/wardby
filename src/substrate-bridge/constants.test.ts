import { expect, it } from "vitest";
import {
  AGENT_SUFFIX,
  ACTOR_JWT_HEADER,
  DIAGNOSTICS_TAIL,
  MAX_CODING_OUTPUT_ISSUES as BRIDGE_MAX_CODING_OUTPUT_ISSUES,
  SAFE_CODING_OUTPUT_ISSUE as BRIDGE_SAFE_CODING_OUTPUT_ISSUE,
  SAFE_WORKER_DIAGNOSTIC as BRIDGE_SAFE_WORKER_DIAGNOSTIC,
  GATEWAY_ACTOR_JWT_PLACEHOLDER,
  PLACEHOLDER_CAPABILITY,
  RESULT_BUNDLE_FILE as BRIDGE_RESULT_BUNDLE_FILE,
  RUN_TOKEN_PATTERN,
  TOOL_SUFFIX,
} from "./constants.js";
import { RESULT_BUNDLE_FILE } from "../providers/jobs/workspace-swap.js";
import {
  agentActorName,
  PLACEHOLDER_CAPABILITY as LAUNCHER_CAPABILITY,
  TOOL_ACTOR_JWT_HEADER,
  substrateRunToken,
  toolActorName,
} from "../providers/jobs/substrate/names.js";
import { tarExcludeArgs as bridgeTarExcludeArgs } from "./tar.js";
import { collectExclusions, tarExcludeArgs } from "../coding/collect-exclude.js";
import {
  MAX_CODING_OUTPUT_ISSUES as PROTOCOL_MAX_CODING_OUTPUT_ISSUES,
  SAFE_CODING_OUTPUT_ISSUE as PROTOCOL_SAFE_CODING_OUTPUT_ISSUE,
} from "../coding/protocol.js";
import {
  parseWorkerDiagnosticLine as sharedParseWorkerDiagnosticLine,
  SAFE_WORKER_DIAGNOSTIC as SHARED_SAFE_WORKER_DIAGNOSTIC,
} from "../providers/jobs/worker-diagnostic.js";
import { MAX_DIAGNOSTICS_BYTES } from "../providers/coding-proxy/substrate/routes.js";
import { parseWorkerDiagnosticLine as bridgeParseWorkerDiagnosticLine } from "./diagnostics.js";

it("matches the launcher's names", () => {
  expect(PLACEHOLDER_CAPABILITY).toBe(LAUNCHER_CAPABILITY);
  const token = substrateRunToken("run-1");
  expect(RUN_TOKEN_PATTERN.test(token)).toBe(true);
  expect(agentActorName(token)).toBe(`${token}${AGENT_SUFFIX}`);
  expect(toolActorName(token)).toBe(`${token}${TOOL_SUFFIX}`);
  expect(GATEWAY_ACTOR_JWT_PLACEHOLDER).toBe("placeholder");
  expect(ACTOR_JWT_HEADER).toBe(TOOL_ACTOR_JWT_HEADER.toLowerCase());
});

it("renders collect exclusions as the repository does", () => {
  const exclusions = collectExclusions(["web/dist"]);
  expect(bridgeTarExcludeArgs(exclusions)).toEqual(tarExcludeArgs(exclusions));
});

it("re-declares the worker diagnostic patterns and bound unchanged", () => {
  expect(BRIDGE_SAFE_WORKER_DIAGNOSTIC.source).toBe(SHARED_SAFE_WORKER_DIAGNOSTIC.source);
  expect(BRIDGE_SAFE_WORKER_DIAGNOSTIC.flags).toBe(SHARED_SAFE_WORKER_DIAGNOSTIC.flags);
  expect(BRIDGE_SAFE_CODING_OUTPUT_ISSUE.source).toBe(PROTOCOL_SAFE_CODING_OUTPUT_ISSUE.source);
  expect(BRIDGE_SAFE_CODING_OUTPUT_ISSUE.flags).toBe(PROTOCOL_SAFE_CODING_OUTPUT_ISSUE.flags);
  expect(BRIDGE_MAX_CODING_OUTPUT_ISSUES).toBe(PROTOCOL_MAX_CODING_OUTPUT_ISSUES);
  expect(DIAGNOSTICS_TAIL.bytes).toBe(MAX_DIAGNOSTICS_BYTES);
});

it("parses worker diagnostic lines exactly as the shared parser does", () => {
  const nine = Array.from({ length: 9 }, (_, i) => `field${String.fromCharCode(97 + i)}:invalid_type`);
  const lines = [
    '{"error":"coding_turn_limit"}',
    '{"error":"worker_tool_runner_unreachable","issues":[]}',
    '{"error":"coding_output_invalid","issues":["summary:too_big","$:invalid_type"]}',
    `{"error":"coding_output_invalid","issues":${JSON.stringify(nine)}}`,
    '{"error":"coding_output_invalid","issues":["summary:too_big","sk-SECRET"]}',
    '{"error":"coding_output_invalid","issues":"summary:too_big"}',
    '{"error":"provider said sk-SECRET"}',
    '{"error":"CODING_TURN_LIMIT"}',
    '{"error":5}',
    '{"issues":["a:b"]}',
    "null",
    "5",
    "[]",
    '"coding_turn_limit"',
    "not json",
    "",
  ];
  for (const line of lines)
    expect(bridgeParseWorkerDiagnosticLine(line)).toEqual(sharedParseWorkerDiagnosticLine(line));
});

it("matches the warm-rounds values of the launcher, the names and the worker", async () => {
  const bridge = await import("./constants.js");
  const specs = await import("../providers/jobs/substrate/specs.js");
  const names = await import("../providers/jobs/substrate/names.js");
  const context = await import("../claude-coding-worker/context.js");
  expect(bridge.WARM_ROUNDS_ENV).toBe(specs.WARM_ROUNDS_ENV);
  expect(bridge.MAX_ROUND).toBe(names.MAX_ROUND);
  expect(bridge.WORKER_CONTEXT_ROOT).toBe(context.CONTEXT_ROOT);
});

it("names the same result bundle as the launcher", () => {
  expect(BRIDGE_RESULT_BUNDLE_FILE).toBe(RESULT_BUNDLE_FILE);
});
