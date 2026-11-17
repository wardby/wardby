import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  CAPABILITY_HEADER_ENV,
  CODEX_WORKER_ENTRY,
  REGISTRY_TOKEN_ENV,
  REGISTRY_TOKEN_SHAPE,
  AGENT_SUFFIX,
  ACTOR_JWT_HEADER,
  CANARY_SUFFIX,
  NATIVE_SUFFIX,
  DIAGNOSTICS_TAIL,
  MAX_CODING_OUTPUT_ISSUES as BRIDGE_MAX_CODING_OUTPUT_ISSUES,
  SAFE_CODING_OUTPUT_ISSUE as BRIDGE_SAFE_CODING_OUTPUT_ISSUE,
  SAFE_WORKER_DIAGNOSTIC as BRIDGE_SAFE_WORKER_DIAGNOSTIC,
  GATEWAY_ACTOR_JWT_PLACEHOLDER,
  IMAGE_ITEMS,
  PLACEHOLDER_CAPABILITY,
  RESULT_BUNDLE_FILE as BRIDGE_RESULT_BUNDLE_FILE,
  PLAN_FILES_OUTPUT_PATH,
  PLAN_FOLDER,
  RUN_TOKEN_PATTERN,
  TOOL_SUFFIX,
} from "./constants.js";
import { RESULT_BUNDLE_FILE } from "../providers/jobs/workspace-swap.js";
import { CANARY_ACTOR_SUFFIX, NATIVE_ACTOR_SUFFIX } from "../providers/substrate/names.js";
import {
  agentActorName,
  PLACEHOLDER_CAPABILITY as LAUNCHER_CAPABILITY,
  SUBSTRATE_IMAGE_ITEMS,
  TOOL_ACTOR_JWT_HEADER,
  substrateRunToken,
  toolActorName,
} from "../providers/jobs/substrate/names.js";
import { tarExcludeArgs as bridgeTarExcludeArgs } from "./tar.js";
import {
  CAPABILITY_HEADER_ENV as WORKER_CAPABILITY_HEADER_ENV,
  INJECTED_CAPABILITY_PLACEHOLDER,
  REGISTRY_TOKEN_ENV as WORKER_REGISTRY_TOKEN_ENV,
  REGISTRY_TOKEN_SHAPE as WORKER_REGISTRY_TOKEN_SHAPE,
} from "../coding-worker/credentials.js";
import { collectExclusions, tarExcludeArgs } from "../coding/collect-exclude.js";
import {
  MAX_CODING_OUTPUT_ISSUES as PROTOCOL_MAX_CODING_OUTPUT_ISSUES,
  PLAN_FILES_ARTIFACT,
  PLAN_FOLDER_PATH,
  SAFE_CODING_OUTPUT_ISSUE as PROTOCOL_SAFE_CODING_OUTPUT_ISSUE,
} from "../coding/protocol.js";
import {
  parseWorkerDiagnosticLine as sharedParseWorkerDiagnosticLine,
  SAFE_WORKER_DIAGNOSTIC as SHARED_SAFE_WORKER_DIAGNOSTIC,
} from "../providers/jobs/worker-diagnostic.js";
import {
  MAX_DIAGNOSTICS_BYTES,
  MCP_TOOLS_INPUT_HEADER as PROXY_MCP_TOOLS_INPUT_HEADER,
} from "../providers/coding-proxy/substrate/routes.js";
import { parseWorkerDiagnosticLine as bridgeParseWorkerDiagnosticLine } from "./diagnostics.js";

it("names the image check's items as the launcher does", () => {
  expect([...IMAGE_ITEMS]).toEqual([...SUBSTRATE_IMAGE_ITEMS]);
});

it("re-declares the plan-files output path and the plan folder unchanged", () => {
  expect(PLAN_FILES_OUTPUT_PATH).toBe(`/run/wardby/output/${PLAN_FILES_ARTIFACT}`);
  expect(PLAN_FOLDER).toBe(PLAN_FOLDER_PATH);
});

it("matches the launcher's names", () => {
  expect(PLACEHOLDER_CAPABILITY).toBe(LAUNCHER_CAPABILITY);
  // The Codex worker checks for this exact placeholder before it goes into header mode.
  expect(INJECTED_CAPABILITY_PLACEHOLDER).toBe(PLACEHOLDER_CAPABILITY);
  const token = substrateRunToken("run-1");
  expect(RUN_TOKEN_PATTERN.test(token)).toBe(true);
  expect(agentActorName(token)).toBe(`${token}${AGENT_SUFFIX}`);
  expect(toolActorName(token)).toBe(`${token}${TOOL_SUFFIX}`);
  expect(GATEWAY_ACTOR_JWT_PLACEHOLDER).toBe("placeholder");
  expect(ACTOR_JWT_HEADER).toBe(TOOL_ACTOR_JWT_HEADER.toLowerCase());
});

it("matches the native launcher's actor suffixes", () => {
  expect(NATIVE_SUFFIX).toBe(NATIVE_ACTOR_SUFFIX);
  expect(CANARY_SUFFIX).toBe(CANARY_ACTOR_SUFFIX);
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

it("matches the Codex worker's header-mode environment and entry point", async () => {
  expect(CAPABILITY_HEADER_ENV).toBe(WORKER_CAPABILITY_HEADER_ENV);
  expect(REGISTRY_TOKEN_ENV).toBe(WORKER_REGISTRY_TOKEN_ENV);
  expect(REGISTRY_TOKEN_SHAPE.source).toBe(WORKER_REGISTRY_TOKEN_SHAPE.source);
  expect(REGISTRY_TOKEN_SHAPE.flags).toBe(WORKER_REGISTRY_TOKEN_SHAPE.flags);
  // Both bases Dockerfile.codex is built on.
  for (const file of ["Dockerfile", "Dockerfile.node-python"]) {
    const dockerfile = await readFile(new URL(`../coding-worker/${file}`, import.meta.url), "utf8");
    const entrypoint = /^ENTRYPOINT\s+\["node",\s*"([^"]+)"\]/m.exec(dockerfile);
    expect(entrypoint?.[1]).toBe(CODEX_WORKER_ENTRY);
  }
});

it("matches the worker's and the proxy's MCP names", async () => {
  const bridge = await import("./constants.js");
  const worker = await import("../coding-worker/mcp-config.js");
  const controlPlane = await import("../coding/mcp-token.js");
  expect(bridge.MCP_TOKEN_ENV).toBe(worker.MCP_TOKEN_ENV);
  expect(bridge.MCP_TOKEN_HEADER_ENV).toBe(worker.MCP_TOKEN_HEADER_ENV);
  expect(bridge.MCP_TOKEN_HEADER).toBe(worker.MCP_TOKEN_HEADER);
  expect(bridge.INJECTED_MCP_TOKEN_PLACEHOLDER).toBe(worker.INJECTED_MCP_TOKEN_PLACEHOLDER);
  expect(bridge.MCP_TOOLS_INPUT_HEADER).toBe(PROXY_MCP_TOOLS_INPUT_HEADER);
  expect(bridge.MCP_TOKEN_HEADER).toBe(controlPlane.MCP_TOKEN_HEADER);
  expect(bridge.INJECTED_MCP_TOKEN_PLACEHOLDER).toBe(controlPlane.INJECTED_MCP_TOKEN_PLACEHOLDER);
  expect(bridge.MCP_TOKEN_ENV).toBe(controlPlane.MCP_TOKEN_ENV);
  expect(bridge.WORKER_PLACEHOLDERS).toEqual([PLACEHOLDER_CAPABILITY, bridge.INJECTED_MCP_TOKEN_PLACEHOLDER]);
});

it("matches the launcher's repository root and bounds", async () => {
  const bridge = await import("./constants.js");
  const storage = await import("../providers/jobs/storage-init.js");
  const protocol = await import("../coding/protocol.js");
  expect(bridge.REPOSITORY_MOUNT_ROOT).toBe(storage.REPOSITORY_MOUNT_ROOT);
  expect(bridge.MAX_SETUP_REPOSITORIES).toBe(protocol.MAX_RUN_REPOSITORIES_IN_INPUT);
  expect(bridge.REPOSITORY_NAME.source).toBe(protocol.CODING_REPOSITORY_NAME.source);
  expect(bridge.REPOSITORY_NAME.flags).toBe(protocol.CODING_REPOSITORY_NAME.flags);
});

it("matches the proxy's bridge protocol header and range", async () => {
  const bridge = await import("./constants.js");
  const names = await import("../providers/jobs/substrate/names.js");
  expect(bridge.BRIDGE_PROTOCOL_HEADER).toBe(names.BRIDGE_PROTOCOL_HEADER);
  expect(Number.isInteger(bridge.BRIDGE_PROTOCOL)).toBe(true);
  expect(bridge.BRIDGE_PROTOCOL).toBe(names.BRIDGE_PROTOCOL_RANGE.max);
  expect(bridge.BRIDGE_PROTOCOL).toBeGreaterThanOrEqual(names.BRIDGE_PROTOCOL_RANGE.min);
});

it("matches the launcher's service paths and bounds", async () => {
  const bridge = await import("./constants.js");
  const script = await import("../providers/jobs/substrate/service-script.js");
  const protocol = await import("../coding/protocol.js");
  expect(bridge.SERVICES_ROOT).toBe(script.SERVICES_ROOT);
  expect(bridge.SERVICE_START_MARKER_MS).toBe(script.SERVICE_START_MARKER_MS);
  expect(bridge.MAX_SERVICES_WAIT_MS).toBe(script.MAX_SERVICES_WAIT_MS);
  expect(bridge.MAX_SERVICE_SCRIPT_BYTES).toBe(script.MAX_SERVICE_SCRIPT_BYTES);
  expect(bridge.MAX_SETUP_SERVICES).toBe(protocol.MAX_CODING_SERVICES);
  expect(bridge.SERVICE_NAME.source).toBe(protocol.CODING_SERVICE_NAME.source);
  expect(bridge.SERVICE_NAME.flags).toBe(protocol.CODING_SERVICE_NAME.flags);
});
