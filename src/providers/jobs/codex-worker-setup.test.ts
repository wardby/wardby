import { describe, expect, it } from "vitest";
import { collectExclusions } from "../../coding/collect-exclude.js";
import { deriveRegistryToken } from "../../coding/registry/token.js";
import type { ResolvedCodingService } from "../../coding/services/catalog.js";
import {
  CODEX_WORKER_SETUP_LIMITS,
  codexWorkerSetup,
  holderSetupRepositories,
  type CodexWorkerSetup,
  type HolderSetupService,
  type HolderSetupRepository,
} from "./codex-worker-setup.js";
import { MAX_SERVICE_SCRIPT_BYTES, MAX_SERVICE_SCRIPTS_BYTES, serviceStartScript } from "./substrate/service-script.js";
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

  it("has no repositories key without extras, and lists exactly what it is given, never a host path", () => {
    expect(JSON.parse(codexWorkerSetup(spec, FAKE_CAP, { collectResultBundle: false }))).not.toHaveProperty(
      "repositories",
    );
    const repositories: HolderSetupRepository[] = [
      { name: "extra-alpha", access: "write", collectResultBundle: true },
      { name: "extra-beta", access: "read" },
    ];
    const raw = codexWorkerSetup(
      {
        ...spec,
        repositories: [
          { name: "extra-alpha", access: "write", hostPath: "/runs/run-codex-setup/repos/extra-alpha/workspace" },
          { name: "extra-beta", access: "read", hostPath: "/runs/run-codex-setup/repos/extra-beta/workspace" },
        ],
      },
      FAKE_CAP,
      { collectResultBundle: false, repositories },
    );
    expect((JSON.parse(raw) as CodexWorkerSetup).repositories).toEqual(repositories);
    expect(raw).not.toContain("hostPath");
    expect(raw).not.toContain("/runs/");
  });
});

const FAKE_SERVICE: ResolvedCodingService = {
  name: "fakedb",
  version: "1",
  image: `registry.example/fakedb@sha256:${"b".repeat(64)}`,
  port: 5999,
  serviceEnv: { FAKEDB_PASSWORD: "FAKE_SERVICE_ENV_VALUE_0001" },
  testEnv: {},
  readiness: { command: ["true"], periodSeconds: 1, timeoutSeconds: 1, failureThreshold: 3 },
  startCommand: ["true"],
  resources: { cpuMillicores: 100, memoryMib: 64, diskMib: 64 },
  dataPath: "/var/lib/fakedb",
  writablePaths: [],
};

describe("codexWorkerSetup services", () => {
  it("has neither services nor servicesWaitMs without services", () => {
    const parsed = JSON.parse(codexWorkerSetup(spec, FAKE_CAP, { collectResultBundle: false }));
    expect(parsed).not.toHaveProperty("services");
    expect(parsed).not.toHaveProperty("servicesWaitMs");
  });

  it("lists name and script only, with the wait bound", () => {
    const entries = [{ name: "fakedb", script: "S", env: { X: "y" } }] as never as HolderSetupService[];
    const setup = JSON.parse(
      codexWorkerSetup(spec, FAKE_CAP, { collectResultBundle: false, services: { entries, waitMs: 45_000 } }),
    ) as CodexWorkerSetup;
    expect(setup.services).toEqual([{ name: "fakedb", script: "S" }]);
    expect(setup.servicesWaitMs).toBe(45_000);
  });

  it("stays inside the setup bound", () => {
    const entry = (name: string, size: number) => ({ name, script: "x".repeat(size) });
    const five = ["a", "b", "c", "d", "e"].map((n) => entry(n, MAX_SERVICE_SCRIPT_BYTES));
    expect(() =>
      codexWorkerSetup(spec, FAKE_CAP, { collectResultBundle: false, services: { entries: five, waitMs: 1 } }),
    ).not.toThrow();
    const six = Array.from({ length: 7 }, (_, i) => entry(`s${i}`, MAX_SERVICE_SCRIPT_BYTES));
    expect(() =>
      codexWorkerSetup(spec, FAKE_CAP, { collectResultBundle: false, services: { entries: six, waitMs: 1 } }),
    ).toThrow("codex_worker_setup_too_large");
    const total = Array.from({ length: 4 }, (_, i) => entry(`t${i}`, MAX_SERVICE_SCRIPTS_BYTES / 4));
    expect(() =>
      codexWorkerSetup(spec, FAKE_CAP, { collectResultBundle: false, services: { entries: total, waitMs: 1 } }),
    ).not.toThrow();
  });

  it("keeps service env values and the capability out of everything but the scripts", () => {
    const raw = codexWorkerSetup({ ...spec, services: [FAKE_SERVICE] }, FAKE_CAP, {
      collectResultBundle: false,
      services: { entries: [{ name: "fakedb", script: serviceStartScript(FAKE_SERVICE) }], waitMs: 33_000 },
    });
    expect(raw).toContain("FAKE_SERVICE_ENV_VALUE_0001");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    delete parsed.services;
    const rest = JSON.stringify(parsed);
    expect(rest).not.toContain("FAKE_SERVICE_ENV_VALUE_0001");
    expect(raw).not.toContain(FAKE_CAP);
  });
});

describe("holderSetupRepositories", () => {
  it("is undefined for a spec without extras", () => {
    expect(holderSetupRepositories({}, new Set())).toBeUndefined();
  });

  it("lists the extras in spec order, a bundle only for a write extra in the history", () => {
    const repositories: JobSpec["repositories"] = [
      { name: "extra-alpha", access: "write", hostPath: "/a" },
      { name: "extra-beta", access: "read", hostPath: "/b" },
    ];
    const history = new Set(["/workspace", "/repos/extra-alpha", "/repos/extra-beta"]);
    expect(holderSetupRepositories({ repositories }, history)).toEqual([
      { name: "extra-alpha", access: "write", collectResultBundle: true },
      { name: "extra-beta", access: "read" },
    ]);
    expect(holderSetupRepositories({ repositories }, new Set(["/workspace"]))).toEqual([
      { name: "extra-alpha", access: "write" },
      { name: "extra-beta", access: "read" },
    ]);
  });
});
