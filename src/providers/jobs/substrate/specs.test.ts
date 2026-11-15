import { describe, expect, it } from "vitest";
import { deriveRegistryToken } from "../../../coding/registry/token.js";
import type { JobSpec } from "../types.js";
import { templateName } from "./names.js";
import {
  agentEgress,
  agentTemplate,
  codexTemplate,
  runSecret,
  toolEgress,
  toolTemplate,
  workerEnv,
  type SubstrateLaunchConfig,
} from "./specs.js";

const FAKE_CAP = "rrp_fake_capability_value_000001";
const TOKEN = "wr-00000000000000000000";
const DIGEST = "a".repeat(64);
const CONFIG: SubstrateLaunchConfig = {
  atespace: "wardby-runs",
  credentialsNamespace: "wardby-run-credentials",
  proxyHost: "coding-proxy.wardby.svc.cluster.local",
  proxyPort: 8787,
};

function fakeClaudeSpec(): JobSpec {
  return {
    kind: "coding-agent",
    runId: "run-1",
    provider: "claude-code",
    image: `registry.example/agent@sha256:${DIGEST}`,
    toolImage: `registry.example/tool@sha256:${"b".repeat(64)}`,
    inputArtifact: "input.json",
    timeoutSec: 600,
    limits: { cpus: 2, memoryMb: 1536, pids: 512, diskMb: 1024 },
    labels: {},
  };
}

describe("substrate spec builders", () => {
  it("never puts a secret in a template, env or egress policy", () => {
    const spec = fakeClaudeSpec();
    const all = JSON.stringify([
      agentTemplate(spec, CONFIG),
      toolTemplate(spec, CONFIG),
      agentEgress(TOKEN, CONFIG),
      toolEgress(CONFIG),
      workerEnv(CONFIG),
    ]);
    expect(all).not.toContain(FAKE_CAP);
    expect(all).not.toContain("rrg_");
    expect(all).not.toContain("rrp_");
    expect(all).not.toContain("WARDBY_TOOL_SETUP");
    expect(all).not.toContain("WARDBY_RUN_TOKEN");
    expect(all).not.toContain("WARDBY_RUN_CAPABILITY");
  });

  it("puts the capability only in the per-run Secret", () => {
    const secret = runSecret(TOKEN, FAKE_CAP, CONFIG);
    expect(secret.stringData).toEqual({ capability: FAKE_CAP });
    expect(secret.metadata).toEqual({
      name: TOKEN,
      namespace: CONFIG.credentialsNamespace,
      labels: { "wardby.dev/substrate-run": TOKEN },
    });
    expect(JSON.stringify(agentEgress(TOKEN, CONFIG))).toContain(
      `ate-secret://k8s.io/default/${CONFIG.credentialsNamespace}/${TOKEN}/capability`,
    );
  });

  it("allows the proxy only", () => {
    expect(agentEgress(TOKEN, CONFIG)).toEqual([
      {
        kind: "http",
        hostnames: [CONFIG.proxyHost],
        ports: [CONFIG.proxyPort],
        replaceHeaders: [
          {
            header: "X-Api-Key",
            credentialUri: `ate-secret://k8s.io/default/${CONFIG.credentialsNamespace}/${TOKEN}/capability`,
          },
        ],
      },
    ]);
    expect(toolEgress(CONFIG)).toEqual([
      {
        kind: "http",
        hostnames: [CONFIG.proxyHost],
        ports: [CONFIG.proxyPort],
        replaceHeaders: [
          {
            header: "X-Wardby-Actor-Jwt",
            prefix: "Bearer ",
            actorJwt: { audiences: ["wardby-coding-proxy"], expirationSeconds: 600 },
          },
        ],
      },
    ]);
  });

  it("names the template by image and size so runs share it", () => {
    const a = agentTemplate(fakeClaudeSpec(), CONFIG);
    expect(a.name).toBe(agentTemplate(fakeClaudeSpec(), CONFIG).name);
    expect(a.name).not.toBe(toolTemplate(fakeClaudeSpec(), CONFIG).name);
    const bigger = fakeClaudeSpec();
    bigger.limits.memoryMb = 4096;
    expect(agentTemplate(bigger, CONFIG).name).not.toBe(a.name);
  });

  it("names the template by everything in it, not only image and size", () => {
    const base = agentTemplate(fakeClaudeSpec(), { ...CONFIG, workerSelector: { pool: "x", zone: "a" } }).name;
    const name = (config: SubstrateLaunchConfig) => agentTemplate(fakeClaudeSpec(), config).name;
    expect(name({ ...CONFIG, workerSelector: { zone: "a", pool: "x" } })).toBe(base);
    expect(
      name({ ...CONFIG, proxyHost: "other.svc.cluster.local", workerSelector: { pool: "x", zone: "a" } }),
    ).not.toBe(base);
    expect(name({ ...CONFIG, proxyPort: 9999, workerSelector: { pool: "x", zone: "a" } })).not.toBe(base);
    expect(name({ ...CONFIG, workerSelector: { pool: "y", zone: "a" } })).not.toBe(base);
    expect(toolTemplate(fakeClaudeSpec(), { ...CONFIG, proxyPort: 9999 }).name).not.toBe(
      toolTemplate(fakeClaudeSpec(), CONFIG).name,
    );
  });

  it("keeps the template name the same across runs and labels", () => {
    const a = fakeClaudeSpec();
    const b = { ...fakeClaudeSpec(), runId: "run-2", labels: { owner: "someone-else" } };
    expect(agentTemplate(b, CONFIG).name).toBe(agentTemplate(a, CONFIG).name);
    expect(toolTemplate(b, CONFIG).name).toBe(toolTemplate(a, CONFIG).name);
  });

  it("refuses a run whose agent share of the limits is not positive", () => {
    const tooSmallMemory = fakeClaudeSpec();
    tooSmallMemory.limits.memoryMb = 128;
    expect(() => agentTemplate(tooSmallMemory, CONFIG)).toThrow("substrate_limits_too_small");
    const tooSmallCpu = fakeClaudeSpec();
    tooSmallCpu.limits.cpus = 0.25;
    expect(() => agentTemplate(tooSmallCpu, CONFIG)).toThrow("substrate_limits_too_small");
  });

  it("builds the agent template", () => {
    const spec = fakeClaudeSpec();
    const t = agentTemplate(spec, { ...CONFIG, workerSelector: { pool: "x" } });
    expect(t.atespace).toBe("wardby-runs");
    expect(t.workerSelector).toEqual({ pool: "x" });
    expect(t.snapshotFidelity).toBe("MEMORY");
    // tool share: 0.25 cpu, floor(1536/3)=512 MB
    expect(t.cpuMillicores).toBe(1750);
    expect(t.memoryBytes).toBe(1024 * 2 ** 20);
    expect(t.containers).toEqual([
      {
        name: "agent",
        image: spec.image,
        env: [{ name: "WARDBY_PROXY_URL", value: `http://${CONFIG.proxyHost}:${CONFIG.proxyPort}` }],
        wakeupProbe: { path: "/readyz", port: 8080 },
        volumeMounts: [
          { name: "run", mountPath: "/run/wardby" },
          { name: "actor", mountPath: "/run/ate/actor" },
        ],
      },
    ]);
    expect(t.volumes).toEqual([
      { name: "run", durableDir: true },
      { name: "actor", actorMetadata: { path: "" } },
    ]);
  });

  it("builds the tool template", () => {
    const spec = fakeClaudeSpec();
    const t = toolTemplate(spec, CONFIG);
    expect(t.cpuMillicores).toBe(250);
    expect(t.memoryBytes).toBe(512 * 2 ** 20);
    expect(t.containers[0]?.name).toBe("tool");
    expect(t.containers[0]?.image).toBe(spec.toolImage);
    expect(t.containers[0]?.volumeMounts).toEqual([
      { name: "run", mountPath: "/run/wardby" },
      { name: "workspace", mountPath: "/workspace" },
      { name: "actor", mountPath: "/run/ate/actor" },
    ]);
    expect(t.volumes.map((v) => v.name)).toEqual(["run", "workspace", "actor"]);
  });

  it("refuses a spec that is not a Claude Code spec with a tool image", () => {
    const spec = fakeClaudeSpec();
    delete spec.toolImage;
    expect(() => toolTemplate(spec, CONFIG)).toThrow("substrate_tool_image_missing");
  });

  describe("codexTemplate", () => {
    const fakeCodexSpec = (): JobSpec => {
      const { toolImage: _tool, ...spec } = fakeClaudeSpec();
      return { ...spec, provider: "codex", image: `registry.example/substrate-codex@sha256:${"d".repeat(64)}` };
    };

    it("builds one container with the run's whole size, the workspace and the actor metadata", () => {
      const spec = fakeCodexSpec();
      const t = codexTemplate(spec, { ...CONFIG, workerSelector: { pool: "x" } });
      expect(t.atespace).toBe("wardby-runs");
      expect(t.workerSelector).toEqual({ pool: "x" });
      expect(t.snapshotFidelity).toBe("MEMORY");
      expect(t.cpuMillicores).toBe(2000);
      expect(t.memoryBytes).toBe(1536 * 2 ** 20);
      expect(t.name).toMatch(/^wardby-codex-[0-9a-f]{16}$/);
      expect(t.containers).toEqual([
        {
          name: "agent",
          image: spec.image,
          env: [{ name: "WARDBY_PROXY_URL", value: `http://${CONFIG.proxyHost}:${CONFIG.proxyPort}` }],
          wakeupProbe: { path: "/readyz", port: 8080 },
          volumeMounts: [
            { name: "run", mountPath: "/run/wardby" },
            { name: "workspace", mountPath: "/workspace" },
            { name: "actor", mountPath: "/run/ate/actor" },
          ],
        },
      ]);
      expect(t.volumes).toEqual([
        { name: "run", durableDir: true },
        { name: "workspace", durableDir: true },
        { name: "actor", actorMetadata: { path: "" } },
      ]);
      expect(t.name).not.toBe(agentTemplate({ ...spec, toolImage: fakeClaudeSpec().toolImage! }, CONFIG).name);
    });

    it("names the template from its content with the codex role", () => {
      const spec = fakeCodexSpec();
      const t = codexTemplate(spec, CONFIG);
      // The variant is everything else in the template: here the env and an empty selector.
      expect(t.name).toMatch(/^wardby-codex-/);
      expect(t.name).not.toBe(templateName("agent", spec.image, t.cpuMillicores, t.memoryBytes, ""));
      expect(codexTemplate({ ...spec, runId: "run-2", labels: { a: "b" } }, CONFIG).name).toBe(t.name);
      expect(codexTemplate(spec, { ...CONFIG, proxyPort: 9999 }).name).not.toBe(t.name);
    });

    it("never takes the warm-rounds env: the same env and name with warm rounds on", () => {
      const spec = fakeCodexSpec();
      const off = codexTemplate(spec, CONFIG);
      const on = codexTemplate(spec, { ...CONFIG, warmRounds: true });
      expect(on).toEqual(off);
      expect(JSON.stringify(on)).not.toContain("WARDBY_SUBSTRATE_WARM_ROUNDS");
    });

    it("never carries the capability, the registry token, a run id or a run token", () => {
      const spec = fakeCodexSpec();
      const json = JSON.stringify(codexTemplate(spec, CONFIG));
      expect(json).not.toContain(FAKE_CAP);
      expect(json).not.toContain(deriveRegistryToken(FAKE_CAP));
      expect(json).not.toContain("rrg_");
      expect(json).not.toContain("rrp_");
      expect(json).not.toContain(spec.runId);
      expect(json).not.toContain("wr-");
    });
  });
});
