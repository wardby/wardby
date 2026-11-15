import { describe, expect, it } from "vitest";
import { collectExclusions } from "../../coding/collect-exclude.js";
import { deriveRegistryToken } from "../../coding/registry/token.js";
import { CODEX_WORKER_SETUP_LIMITS, codexWorkerSetup, type CodexWorkerSetup } from "./codex-worker-setup.js";
import type { JobSpec } from "./types.js";

const FAKE_CAP = "rrp_fake_capability_value_000001";
const spec: JobSpec = {
  kind: "coding-agent",
  runId: "run-codex-setup",
  provider: "codex",
  image: `registry.example/wardby-substrate-codex@sha256:${"a".repeat(64)}`,
  inputArtifact: "/tmp/input.json",
  timeoutSec: 900,
  limits: { cpus: 1, memoryMb: 2048, pids: 128, diskMb: 2048 },
  labels: {},
};

describe("codexWorkerSetup", () => {
  it("carries the derived registry token, never the capability", () => {
    const raw = codexWorkerSetup(spec, FAKE_CAP, { collectResultBundle: false });
    const setup = JSON.parse(raw) as CodexWorkerSetup;
    expect(setup.schemaVersion).toBe(1);
    expect(setup.registryToken).toBe(deriveRegistryToken(FAKE_CAP));
    expect(raw).not.toContain(FAKE_CAP);
  });

  it("defaults the exclusions to the built-in names and honours the spec's", () => {
    const plain = JSON.parse(codexWorkerSetup(spec, FAKE_CAP, { collectResultBundle: false })) as CodexWorkerSetup;
    expect(plain.collectExclude).toEqual(collectExclusions([]));
    const own = collectExclusions(["dist", "out/cache"]);
    const custom = JSON.parse(
      codexWorkerSetup({ ...spec, collectExclude: own }, FAKE_CAP, { collectResultBundle: false }),
    ) as CodexWorkerSetup;
    expect(custom.collectExclude).toEqual(own);
  });

  it("asks for the result bundle only on a git-history run", () => {
    expect(JSON.parse(codexWorkerSetup(spec, FAKE_CAP, { collectResultBundle: false }))).not.toHaveProperty(
      "collectResultBundle",
    );
    expect(JSON.parse(codexWorkerSetup(spec, FAKE_CAP, { collectResultBundle: true })).collectResultBundle).toBe(true);
  });

  it("refuses a non-Codex spec", () => {
    expect(() =>
      codexWorkerSetup({ ...spec, provider: "claude-code" }, FAKE_CAP, { collectResultBundle: false }),
    ).toThrow("codex_worker_setup_provider");
    expect(() => codexWorkerSetup({ ...spec, provider: undefined }, FAKE_CAP, { collectResultBundle: false })).toThrow(
      "codex_worker_setup_provider",
    );
  });

  it("refuses a setup past its bound", () => {
    // Past what collectExclusions allows, as an untrusted shape could be.
    const paths = Array.from({ length: 200 }, (_, i) => `${"p".repeat(500)}${i}`);
    expect(JSON.stringify(paths).length).toBeGreaterThan(CODEX_WORKER_SETUP_LIMITS.maxSetupBytes);
    expect(() =>
      codexWorkerSetup({ ...spec, collectExclude: { names: [], paths } }, FAKE_CAP, { collectResultBundle: false }),
    ).toThrow("codex_worker_setup_too_large");
  });
});
