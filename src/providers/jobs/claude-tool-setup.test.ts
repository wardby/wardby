import { describe, expect, it } from "vitest";
import { deriveRegistryToken } from "../../coding/registry/token.js";
import { registryWorkerSetup } from "../../coding/registry/worker-config.js";
import { BUILTIN_CODING_SERVICES } from "../../coding/services/builtins.js";
import { MAX_AGENT_SERVICES, MAX_SERVICE_ENV, resolvedFromDefinition } from "../../coding/services/catalog.js";
import {
  MAX_ENV_ENTRIES,
  MAX_ENV_VALUE_BYTES,
  MAX_FILE_BYTES,
  MAX_FILES,
  MAX_SETUP_BYTES,
  MAX_COMMAND_TIMEOUT_MS,
  TOOL_SETUP_ENV,
  commandTimeoutLimits,
  parseToolSetup,
} from "../../claude-tool-runner/command.mjs";
import { MAX_CLAUDE_COMMAND_TIMEOUT_MS } from "../../coding/command-timeouts.js";
import { CLAUDE_TOOL_SETUP_LIMITS, claudeToolSetup } from "./claude-tool-setup.js";
import { CLAUDE_TOOL_SETUP_ENV } from "./docker-isolation.js";
import type { JobSpec } from "./types.js";

const CAPABILITY = `rrp_${"c".repeat(32)}`;
const spec: JobSpec = {
  kind: "coding-agent",
  runId: "run-claude-setup",
  provider: "claude-code",
  image: `registry.example/wardby-claude-coding-worker@sha256:${"a".repeat(64)}`,
  toolImage: `registry.example/wardby-claude-tool-runner@sha256:${"b".repeat(64)}`,
  inputArtifact: "/tmp/input.json",
  timeoutSec: 900,
  limits: { cpus: 1, memoryMb: 2048, pids: 128, diskMb: 2048 },
  labels: {},
};
const POSTGRES = resolvedFromDefinition(
  BUILTIN_CODING_SERVICES.find((s) => s.name === "postgres" && s.version === "16")!,
);

describe("claudeToolSetup", () => {
  it("names its environment variable", () => {
    expect(CLAUDE_TOOL_SETUP_ENV).toBe("WARDBY_TOOL_SETUP");
  });

  it("delivers the setup under the exact name the tool runner reads", () => {
    expect(CLAUDE_TOOL_SETUP_ENV).toBe(TOOL_SETUP_ENV);
  });

  it("carries the dependency cache flag only when on, and the tool runner reads it back", () => {
    const on = claudeToolSetup({ ...spec, dependencyCache: true, limits: { ...spec.limits, diskMb: 768 } }, CAPABILITY);
    expect(JSON.parse(on)).toMatchObject({ dependencyCache: true, diskMb: 768 });
    expect(parseToolSetup(on)).toMatchObject({ dependencyCache: true, diskMb: 768 });
    const off = claudeToolSetup(spec, CAPABILITY);
    expect(JSON.parse(off)).not.toHaveProperty("dependencyCache");
    expect(JSON.parse(off)).not.toHaveProperty("diskMb");
    expect(parseToolSetup(off)).not.toHaveProperty("dependencyCache");
    expect(parseToolSetup(off)).not.toHaveProperty("diskMb");
  });

  it("carries the run's per-command timeouts, and the tool runner reads them back as its limits", () => {
    const raw = claudeToolSetup({ ...spec, commandTimeouts: { defaultMs: 300_000, maxMs: 300_000 } }, CAPABILITY);
    expect(JSON.parse(raw)).toMatchObject({ commandTimeouts: { defaultMs: 300_000, maxMs: 300_000 } });
    expect(commandTimeoutLimits(parseToolSetup(raw))).toEqual({ defaultMs: 300_000, maxMs: 300_000 });
    // A spec without them (an older control plane) keeps the tool runner's old 60 s / 120 s limits.
    const legacy = claudeToolSetup(spec, CAPABILITY);
    expect(JSON.parse(legacy)).not.toHaveProperty("commandTimeouts");
    expect(commandTimeoutLimits(parseToolSetup(legacy))).toEqual({ defaultMs: 60_000, maxMs: 120_000 });
  });

  it("accepts per-command timeouts up to the longest run timeout and nothing the tool runner would refuse", () => {
    expect(MAX_COMMAND_TIMEOUT_MS).toBe(MAX_CLAUDE_COMMAND_TIMEOUT_MS);
    const setup = (commandTimeouts: unknown) =>
      JSON.stringify({ schemaVersion: 1, env: {}, files: [], commandTimeouts });
    expect(
      commandTimeoutLimits(parseToolSetup(setup({ defaultMs: 1_000, maxMs: MAX_CLAUDE_COMMAND_TIMEOUT_MS }))),
    ).toEqual({ defaultMs: 1_000, maxMs: MAX_CLAUDE_COMMAND_TIMEOUT_MS });
    for (const bad of [
      { defaultMs: 999, maxMs: 600_000 },
      { defaultMs: 600_000, maxMs: MAX_CLAUDE_COMMAND_TIMEOUT_MS + 1 },
      { defaultMs: 600_000, maxMs: 300_000 },
      { defaultMs: 1.5e3, maxMs: 600_000.5 },
      { defaultMs: "600000", maxMs: 600_000 },
      [600_000, 600_000],
      null,
    ]) {
      expect(() => parseToolSetup(setup(bad))).toThrow("tool_setup_invalid");
    }
  });

  it("hands the tool runner the registry settings a Codex shell gets, under /workspace/.cache", () => {
    const expected = registryWorkerSetup({
      proxyBaseUrl: "http://wardby-proxy:8787",
      capability: CAPABILITY,
      cacheRoot: "/workspace/.cache",
    });
    expect(JSON.parse(claudeToolSetup(spec, CAPABILITY))).toEqual({
      schemaVersion: 1,
      env: expected.env,
      files: expected.files,
    });
  });

  it("carries the registry-only token and never the capability", () => {
    const raw = claudeToolSetup(spec, CAPABILITY);
    expect(raw).not.toContain(CAPABILITY);
    expect(raw).toContain(deriveRegistryToken(CAPABILITY));
  });

  it("adds each service's test variables", () => {
    const setup = JSON.parse(claudeToolSetup({ ...spec, services: [POSTGRES] }, CAPABILITY));
    expect(setup.env).toMatchObject(POSTGRES.testEnv);
  });

  it("carries dependencyCache only when the run turned it on", () => {
    expect(JSON.parse(claudeToolSetup(spec, CAPABILITY))).not.toHaveProperty("dependencyCache");
    expect(JSON.parse(claudeToolSetup({ ...spec, dependencyCache: true }, CAPABILITY))).toMatchObject({
      dependencyCache: true,
    });
  });

  it("refuses a Codex spec", () => {
    expect(() => claudeToolSetup({ ...spec, provider: "codex", toolImage: undefined }, CAPABILITY)).toThrow(
      "claude_tool_setup_provider",
    );
  });

  it("builds within exactly the limits the tool runner enforces", () => {
    expect(CLAUDE_TOOL_SETUP_LIMITS).toEqual({
      maxEnvEntries: MAX_ENV_ENTRIES,
      maxEnvValueBytes: MAX_ENV_VALUE_BYTES,
      maxFiles: MAX_FILES,
      maxFileBytes: MAX_FILE_BYTES,
      maxSetupBytes: MAX_SETUP_BYTES,
    });
  });

  it("leaves room for every variable of the most services a run can carry", () => {
    const registry = registryWorkerSetup({
      proxyBaseUrl: "http://wardby-proxy:8787",
      capability: CAPABILITY,
      cacheRoot: "/workspace/.cache",
    });
    expect(MAX_ENV_ENTRIES).toBeGreaterThanOrEqual(
      MAX_AGENT_SERVICES * MAX_SERVICE_ENV + Object.keys(registry.env).length,
    );
    const services = Array.from({ length: MAX_AGENT_SERVICES }, (_, index) => ({
      ...POSTGRES,
      name: `svc-${index}`,
      testEnv: Object.fromEntries(
        Array.from({ length: MAX_SERVICE_ENV }, (_, variable) => [`S${index}_V${variable}`, "x"]),
      ),
    }));
    const raw = claudeToolSetup({ ...spec, services }, CAPABILITY);
    expect(Object.keys(parseToolSetup(raw).env)).toHaveLength(
      MAX_AGENT_SERVICES * MAX_SERVICE_ENV + Object.keys(registry.env).length,
    );
  });

  it("refuses to build a setup the tool runner would reject, rather than launching a runner that never gets ready", () => {
    const oversized = (testEnv: Record<string, string>) => ({
      ...spec,
      services: [{ ...POSTGRES, testEnv }],
    });
    // Too many bytes in total: the setup travels as one environment variable.
    const bulky = Object.fromEntries(
      Array.from({ length: Math.ceil(MAX_SETUP_BYTES / 1000) + 1 }, (_, index) => [`BULK_${index}`, "x".repeat(1000)]),
    );
    expect(() => claudeToolSetup(oversized(bulky), CAPABILITY)).toThrow("claude_tool_setup_too_large");
    // One value over the per-value cap.
    expect(() => claudeToolSetup(oversized({ BIG: "x".repeat(MAX_ENV_VALUE_BYTES + 1) }), CAPABILITY)).toThrow(
      "claude_tool_setup_too_large",
    );
    // Too many entries.
    const many = Object.fromEntries(Array.from({ length: MAX_ENV_ENTRIES + 1 }, (_, index) => [`V${index}`, "x"]));
    expect(() => claudeToolSetup(oversized(many), CAPABILITY)).toThrow("claude_tool_setup_too_large");
  });
});
