import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deriveRegistryToken } from "../../../coding/registry/token.js";
import type { JobSpec } from "../types.js";
import { templateName } from "./names.js";
import {
  BRIDGE_COMMANDS,
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
const FAKE_MCP = "rmt_FAKE_MCP_TOKEN_NOT_REAL_" + "1".repeat(19);
const TOKEN = "wr-00000000000000000000";
const DIGEST = "a".repeat(64);
const CUSTOM_TOOL_IMAGE = "registry.example/byo-tool@sha256:" + "e".repeat(64);
const CUSTOM_CODEX_IMAGE = "registry.example/byo-codex@sha256:" + "9".repeat(64);
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

function fakeCodexSpec(): JobSpec {
  const { toolImage: _tool, ...spec } = fakeClaudeSpec();
  return { ...spec, provider: "codex", image: `registry.example/substrate-codex@sha256:${"d".repeat(64)}` };
}

const REPOSITORIES: NonNullable<JobSpec["repositories"]> = [
  { name: "extra-alpha", access: "write", hostPath: "/runs/run-1/repos/extra-alpha/workspace" },
];
const REPOS_SPEC: JobSpec = { ...fakeClaudeSpec(), repositories: REPOSITORIES };
const REPOS_CODEX_SPEC: JobSpec = { ...fakeCodexSpec(), repositories: REPOSITORIES };

describe("substrate spec builders", () => {
  it("pins the tool and Codex template names (with the bridge command)", () => {
    expect(agentTemplate(fakeClaudeSpec(), CONFIG).name).toBe("wardby-agent-e531f66094b4abb3");
    expect(toolTemplate(fakeClaudeSpec(), CONFIG).name).toBe("wardby-tool-4e75abf2e2df9092");
    expect(codexTemplate(fakeCodexSpec(), CONFIG).name).toBe("wardby-codex-43f51d8682886d7b");
  });

  it("sets the bridge command on every template", () => {
    const configs = [CONFIG, { ...CONFIG, warmRounds: true }];
    for (const config of configs) {
      for (const spec of [fakeClaudeSpec(), REPOS_SPEC]) {
        expect(agentTemplate(spec, config).containers[0]?.command).toEqual([
          "node",
          "/opt/wardby/substrate-bridge/agent.js",
        ]);
        expect(toolTemplate(spec, config).containers[0]?.command).toEqual([
          "node",
          "/opt/wardby/substrate-bridge/tool.js",
        ]);
      }
      for (const spec of [fakeCodexSpec(), REPOS_CODEX_SPEC]) {
        expect(codexTemplate(spec, config).containers[0]?.command).toEqual([
          "node",
          "/opt/wardby/substrate-bridge/codex.js",
        ]);
      }
    }
  });

  it("uses the bridge images' own entrypoints", () => {
    for (const role of ["agent", "tool", "codex"] as const) {
      const dockerfile = readFileSync(new URL(`../../../substrate-bridge/Dockerfile.${role}`, import.meta.url), "utf8");
      expect(dockerfile).toContain(`ENTRYPOINT ${JSON.stringify(BRIDGE_COMMANDS[role]).replace(/,/g, ", ")}`);
    }
  });

  it("names a custom tool image's template by its digest and keeps the agent template shared", () => {
    const custom: JobSpec = { ...fakeClaudeSpec(), toolImage: CUSTOM_TOOL_IMAGE };
    const t = toolTemplate(custom, CONFIG);
    expect(t.name).not.toBe(toolTemplate(fakeClaudeSpec(), CONFIG).name);
    expect(t.name).toMatch(/^wardby-tool-[0-9a-f]{16}$/);
    expect(agentTemplate(custom, CONFIG)).toEqual(agentTemplate(fakeClaudeSpec(), CONFIG));
    expect(t.containers[0]?.image).toBe(CUSTOM_TOOL_IMAGE);
    expect(t.containers[0]?.command).toEqual(["node", "/opt/wardby/substrate-bridge/tool.js"]);
  });

  it("names a custom Codex image's template by its digest", () => {
    const custom: JobSpec = { ...fakeCodexSpec(), image: CUSTOM_CODEX_IMAGE };
    const t = codexTemplate(custom, CONFIG);
    expect(t.name).not.toBe(codexTemplate(fakeCodexSpec(), CONFIG).name);
    expect(t.name).toMatch(/^wardby-codex-[0-9a-f]{16}$/);
    expect(t.containers[0]?.image).toBe(CUSTOM_CODEX_IMAGE);
    expect(t.containers[0]?.command).toEqual(["node", "/opt/wardby/substrate-bridge/codex.js"]);
  });

  it("mounts /repos on the tool template only for a spec with repositories", () => {
    const plain = toolTemplate(fakeClaudeSpec(), CONFIG);
    const t = toolTemplate(REPOS_SPEC, CONFIG);
    expect(t.volumes).toEqual([
      { name: "run", durableDir: true },
      { name: "workspace", durableDir: true },
      { name: "repos", durableDir: true },
      { name: "actor", actorMetadata: { path: "" } },
    ]);
    expect(t.containers[0]?.volumeMounts).toEqual([
      { name: "run", mountPath: "/run/wardby" },
      { name: "workspace", mountPath: "/workspace" },
      { name: "repos", mountPath: "/repos" },
      { name: "actor", mountPath: "/run/ate/actor" },
    ]);
    expect(t.name).not.toBe(plain.name);
    const other = toolTemplate(
      { ...fakeClaudeSpec(), repositories: [{ name: "extra-beta", access: "read", hostPath: "/y" }] },
      CONFIG,
    );
    expect(other.name).toBe(t.name);
    expect(other).toEqual(t);
    expect(t.cpuMillicores).toBe(plain.cpuMillicores);
    expect(t.memoryBytes).toBe(plain.memoryBytes);
  });

  it("never mounts /repos on the agent template", () => {
    expect(agentTemplate(REPOS_SPEC, CONFIG)).toEqual(agentTemplate(fakeClaudeSpec(), CONFIG));
  });

  it("mounts /repos on the Codex template the same way", () => {
    const plain = codexTemplate(fakeCodexSpec(), CONFIG);
    const t = codexTemplate(REPOS_CODEX_SPEC, CONFIG);
    expect(t.volumes).toEqual([
      { name: "run", durableDir: true },
      { name: "workspace", durableDir: true },
      { name: "repos", durableDir: true },
      { name: "actor", actorMetadata: { path: "" } },
    ]);
    expect(t.containers[0]?.volumeMounts).toEqual([
      { name: "run", mountPath: "/run/wardby" },
      { name: "workspace", mountPath: "/workspace" },
      { name: "repos", mountPath: "/repos" },
      { name: "actor", mountPath: "/run/ate/actor" },
    ]);
    expect(t.name).not.toBe(plain.name);
    expect(
      codexTemplate(
        { ...fakeCodexSpec(), repositories: [{ name: "extra-beta", access: "read", hostPath: "/y" }] },
        CONFIG,
      ).name,
    ).toBe(t.name);
    expect(t.cpuMillicores).toBe(plain.cpuMillicores);
    expect(t.memoryBytes).toBe(plain.memoryBytes);
  });

  it("never puts a secret in a template, env or egress policy", () => {
    const spec = fakeClaudeSpec();
    const templates = [
      agentTemplate(spec, CONFIG),
      toolTemplate(spec, CONFIG),
      toolTemplate(REPOS_SPEC, CONFIG),
      codexTemplate(REPOS_CODEX_SPEC, CONFIG),
      toolTemplate({ ...spec, toolImage: CUSTOM_TOOL_IMAGE }, CONFIG),
      codexTemplate({ ...fakeCodexSpec(), image: CUSTOM_CODEX_IMAGE }, CONFIG),
      agentTemplate({ ...spec, mcpTools: true }, CONFIG),
      toolTemplate({ ...spec, mcpTools: true }, CONFIG),
      codexTemplate({ ...fakeCodexSpec(), mcpTools: true }, CONFIG),
    ];
    // Templates are shared across runs: no run id or run token either (the egress policy names the
    // per-run Secret by token, so that check is for templates only).
    const shared = JSON.stringify(templates);
    expect(shared).not.toContain(spec.runId);
    expect(shared).not.toContain(TOKEN);
    expect(shared).not.toContain("wr-");
    const all = JSON.stringify([
      ...templates,
      agentEgress(TOKEN, CONFIG),
      agentEgress(TOKEN, CONFIG, { mcp: true }),
      toolEgress(CONFIG),
      workerEnv(CONFIG),
    ]);
    expect(all).not.toContain(FAKE_CAP);
    expect(all).not.toContain(FAKE_MCP);
    expect(all).not.toContain(deriveRegistryToken(FAKE_CAP));
    expect(all).not.toContain("rmt_");
    expect(all).not.toContain("rrg_");
    expect(all).not.toContain("rrp_");
    expect(all).not.toContain("WARDBY_TOOL_SETUP");
    expect(all).not.toContain("WARDBY_RUN_TOKEN");
    expect(all).not.toContain("WARDBY_RUN_CAPABILITY");
    expect(all).not.toContain("extra-alpha");
    expect(all).not.toContain("/runs/");
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

  it("puts the MCP token only in the per-run Secret, under its own key", () => {
    expect(runSecret(TOKEN, FAKE_CAP, CONFIG, FAKE_MCP).stringData).toEqual({
      capability: FAKE_CAP,
      mcpToken: FAKE_MCP,
    });
    const plain = runSecret(TOKEN, FAKE_CAP, CONFIG);
    expect(plain.stringData).toEqual({ capability: FAKE_CAP });
    expect(plain.stringData).not.toHaveProperty("mcpToken");
  });

  it("adds the MCP token header to the agent's rule only with mcp", () => {
    expect(agentEgress(TOKEN, CONFIG, { mcp: false })).toEqual(agentEgress(TOKEN, CONFIG));
    expect(agentEgress(TOKEN, CONFIG, { mcp: true })).toEqual([
      {
        kind: "http",
        hostnames: ["coding-proxy.wardby.svc.cluster.local"],
        ports: [8787],
        replaceHeaders: [
          {
            header: "X-Api-Key",
            credentialUri: `ate-secret://k8s.io/default/wardby-run-credentials/${TOKEN}/capability`,
          },
          {
            header: "X-Wardby-Mcp-Token",
            credentialUri: `ate-secret://k8s.io/default/wardby-run-credentials/${TOKEN}/mcpToken`,
          },
        ],
      },
    ]);
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
        command: ["node", "/opt/wardby/substrate-bridge/agent.js"],
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
    expect(t.containers[0]?.command).toEqual([...BRIDGE_COMMANDS.tool]);
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
          command: ["node", "/opt/wardby/substrate-bridge/codex.js"],
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
