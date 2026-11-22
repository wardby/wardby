import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  codingEnvUpdates,
  codingStep,
  defaultTrustedFolder,
  quickstartComposeFiles,
  type CodingDeps,
  type CommandResult,
} from "./coding.js";
import type { CodingSeedInput } from "./coding-seed.js";
import { quickstartPaths, readQuickstartEnv, writeQuickstartEnv, type QuickstartState } from "./config.js";

const RUNTIME = `ghcr.io/wardby/wardby-runtime@sha256:${"1".repeat(64)}`;
const WORKER = `ghcr.io/wardby/wardby-coding-worker@sha256:${"2".repeat(64)}`;
const BUILT_ID = `sha256:${"3".repeat(64)}`;

let scratch: string;
let repoA: string;
let folderB: string;
let projectDir: string;
let packageRoot: string;

const gitIn = (dir: string, ...args: string[]): string =>
  execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    stdio: "pipe",
    encoding: "utf8",
  });

function makeRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  gitIn(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  gitIn(dir, "add", ".");
  gitIn(dir, "commit", "-q", "-m", "init");
}

function commitServices(dir: string, text: string): void {
  mkdirSync(join(dir, ".wardby"), { recursive: true });
  writeFileSync(join(dir, ".wardby", "services.yaml"), text);
  gitIn(dir, "add", ".wardby/services.yaml");
  gitIn(dir, "commit", "-q", "-m", "services");
}

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "quickstart-coding-")));
  repoA = join(scratch, "repo-a");
  folderB = join(scratch, "folder-b");
  projectDir = join(scratch, "project");
  packageRoot = join(scratch, "package");
  makeRepo(repoA);
  mkdirSync(folderB);
  mkdirSync(projectDir);
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  writeFileSync(
    join(packageRoot, "dist", "quickstart-images.json"),
    JSON.stringify({ runtime: RUNTIME, worker: WORKER }),
  );
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const state: QuickstartState = {
  version: 1,
  projectDir: "",
  composeProject: "wardby-test-abc",
  postgresPort: 55432,
  provider: "openai",
  model: "gpt-5.6-luna",
  packageVersion: "0.0.0",
  createdAt: "2026-10-07T00:00:00.000Z",
};

function harness(overrides: Partial<CodingDeps> = {}) {
  const calls: string[][] = [];
  const logs: string[] = [];
  const seeds: Array<Omit<CodingSeedInput, "ownerId">> = [];
  const pulledServiceImages: string[][] = [];
  const run = (command: string, args: string[]): CommandResult => {
    calls.push([command, ...args]);
    if (args[0] === "image" && args[1] === "inspect" && args.includes("--format")) {
      return { status: 0, stdout: `${BUILT_ID}\n`, stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const deps: CodingDeps = {
    run,
    prompts: {
      line: async () => {
        throw new Error("no prompts in non-interactive tests");
      },
      yesNo: async () => {
        throw new Error("no prompts in non-interactive tests");
      },
      secret: async () => {
        throw new Error("no prompts in non-interactive tests");
      },
    },
    log: (line) => logs.push(line),
    cwd: repoA,
    env: {},
    packageRoot,
    seed: async (input) => {
      seeds.push(input);
      return { builder: { id: "b1", status: "created" }, reviewer: { id: "r1", status: "created" } };
    },
    catalogImages: async (services) => {
      pulledServiceImages.push(services.map((service) => `${service.name}:${service.version}`));
      return services.map((service) => ({
        service,
        image: `docker.io/library/${service.name}@sha256:${"9".repeat(64)}`,
      }));
    },
    ...overrides,
  };
  return { deps, calls, logs, seeds, pulledServiceImages };
}

function paths() {
  return quickstartPaths(projectDir);
}

describe("defaultTrustedFolder", () => {
  it("is the top level of the git work tree containing cwd", () => {
    mkdirSync(join(repoA, "nested", "deeper"), { recursive: true });
    expect(defaultTrustedFolder(join(repoA, "nested", "deeper"))).toBe(repoA);
  });

  it("is null outside a git work tree", () => {
    expect(defaultTrustedFolder(folderB)).toBeNull();
  });
});

describe("codingEnvUpdates", () => {
  it("joins roots with the platform path delimiter and selects the docker launcher", () => {
    const updates = codingEnvUpdates({
      roots: ["/a", "/b"],
      provider: "codex",
      workerImage: WORKER,
      runtimeImage: RUNTIME,
    });
    expect(updates).toEqual({
      LOCAL_REPO_ROOTS: `/a${delimiter}/b`,
      JOB_LAUNCHER: "docker",
      CODING_WORKER_IMAGE: WORKER,
      WARDBY_RUNTIME_IMAGE: RUNTIME,
      CODING_PROXY_CONTAINER: "wardby-coding-proxy",
    });
  });

  it("adds the Claude Code images only for claude-code", () => {
    const updates = codingEnvUpdates({
      roots: ["/a"],
      provider: "claude-code",
      workerImage: WORKER,
      runtimeImage: RUNTIME,
      claudeWorkerImage: "sha256:c",
      claudeToolRunnerImage: "sha256:t",
    });
    expect(updates.CODING_CLAUDE_WORKER_IMAGE).toBe("sha256:c");
    expect(updates.CODING_CLAUDE_TOOL_RUNNER_IMAGE).toBe("sha256:t");
  });
});

describe("codingEnvUpdates without a Codex worker", () => {
  it("writes no CODING_WORKER_IMAGE for claude-code", () => {
    const updates = codingEnvUpdates({
      roots: ["/a"],
      provider: "claude-code",
      runtimeImage: RUNTIME,
      claudeWorkerImage: "sha256:c",
      claudeToolRunnerImage: "sha256:t",
    });
    expect(updates).not.toHaveProperty("CODING_WORKER_IMAGE");
  });
});

describe("codingStep (non-interactive)", () => {
  it("--no-coding leaves the env untouched and runs nothing", async () => {
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test" });
    const before = readFileSync(paths().envFile, "utf8");
    const { deps, calls, seeds } = harness();
    const result = await codingStep(paths(), state, { nonInteractive: true, coding: false, trust: [repoA] }, deps);
    expect(result).toBeNull();
    expect(readFileSync(paths().envFile, "utf8")).toBe(before);
    expect(calls).toEqual([]);
    expect(seeds).toEqual([]);
  });

  it("is skipped without --coding when non-interactive", async () => {
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test" });
    const before = readFileSync(paths().envFile, "utf8");
    const { deps, calls } = harness();
    expect(await codingStep(paths(), state, { nonInteractive: true, trust: [] }, deps)).toBeNull();
    expect(readFileSync(paths().envFile, "utf8")).toBe(before);
    expect(calls).toEqual([]);
  });

  it("--coding --trust A --trust B writes the env, starts the proxy, and seeds both agents", async () => {
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test", DATABASE_URL: "postgresql://x" });
    const { deps, calls, seeds } = harness();
    const result = await codingStep(
      paths(),
      state,
      { nonInteractive: true, coding: true, trust: [repoA, folderB] },
      deps,
    );

    const env = readQuickstartEnv(paths());
    expect(env).toMatchObject({
      OPENAI_API_KEY: "sk-test",
      DATABASE_URL: "postgresql://x",
      LOCAL_REPO_ROOTS: `${repoA}${delimiter}${folderB}`,
      JOB_LAUNCHER: "docker",
      CODING_WORKER_IMAGE: WORKER,
      WARDBY_RUNTIME_IMAGE: RUNTIME,
      CODING_PROXY_CONTAINER: "wardby-coding-proxy",
    });

    expect(calls).toContainEqual(["docker", "pull", RUNTIME]);
    expect(calls).toContainEqual(["docker", "pull", WORKER]);
    const up = calls.find((call) => call.includes("up"))!;
    expect(up).toEqual(expect.arrayContaining(["compose", "--project-name", "wardby-test-abc", "coding-proxy"]));
    expect(up.filter((arg) => arg.endsWith("docker-compose.quickstart-coding.yml"))).toHaveLength(1);
    // The in-process preflight inspected the worker image.
    expect(calls).toContainEqual(["docker", "image", "inspect", WORKER]);

    expect(seeds).toEqual([
      {
        provider: "codex",
        builderModel: "gpt-5.6-luna",
        reviewerModel: "gpt-5.6-terra",
        repository: `local:${repoA}`,
        baseRef: "main",
        services: [],
      },
    ]);
    expect(result).toMatchObject({ roots: [repoA, folderB], repository: `local:${repoA}`, provider: "codex" });
    // Nothing was written into the repository without --starter-services.
    expect(gitIn(repoA, "branch", "--list", "wardby/*").trim()).toBe("");
  });

  it("keeps roots from an earlier run and adds new ones", async () => {
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test", LOCAL_REPO_ROOTS: repoA });
    const { deps } = harness();
    await codingStep(paths(), state, { nonInteractive: true, coding: true, trust: [folderB] }, deps);
    expect(readQuickstartEnv(paths()).LOCAL_REPO_ROOTS).toBe(`${repoA}${delimiter}${folderB}`);
  });

  it("needs --trust when no folder is trusted yet", async () => {
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test" });
    const before = readFileSync(paths().envFile, "utf8");
    const { deps, logs, calls } = harness();
    expect(await codingStep(paths(), state, { nonInteractive: true, coding: true, trust: [] }, deps)).toBeNull();
    expect(logs.join("\n")).toMatch(/--trust/);
    expect(readFileSync(paths().envFile, "utf8")).toBe(before);
    expect(calls).toEqual([]);
  });

  it("refuses a --trust folder that does not exist", async () => {
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test" });
    const { deps, logs } = harness();
    const result = await codingStep(
      paths(),
      state,
      { nonInteractive: true, coding: true, trust: [join(scratch, "missing")] },
      deps,
    );
    expect(result).toBeNull();
    expect(logs.join("\n")).toMatch(/does not exist/);
  });

  it("skips when the chosen provider has no key", async () => {
    writeQuickstartEnv(paths(), {});
    const { deps, logs, calls } = harness();
    const result = await codingStep(
      paths(),
      state,
      { nonInteractive: true, coding: true, trust: [repoA], provider: "codex" },
      deps,
    );
    expect(result).toBeNull();
    expect(logs.join("\n")).toMatch(/OPENAI_API_KEY/);
    expect(calls).toEqual([]);
  });

  it("builds the images from a source checkout and pins the worker by its local image id", async () => {
    rmSync(join(packageRoot, "dist", "quickstart-images.json"));
    mkdirSync(join(packageRoot, "deploy"));
    writeFileSync(join(packageRoot, "deploy", "Dockerfile"), "FROM scratch\n");
    mkdirSync(join(packageRoot, "src", "coding-worker"), { recursive: true });
    writeFileSync(join(packageRoot, "src", "coding-worker", "Dockerfile"), "FROM scratch\n");
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test" });
    const { deps, calls } = harness();
    await codingStep(paths(), state, { nonInteractive: true, coding: true, trust: [repoA] }, deps);

    const builds = calls.filter((call) => call[1] === "build");
    expect(builds).toHaveLength(2);
    expect(builds[0]).toEqual(
      expect.arrayContaining(["--file", join(packageRoot, "deploy", "Dockerfile"), "--target", "runtime"]),
    );
    expect(builds[0]).toEqual(expect.arrayContaining(["--tag", "wardby-runtime:local", packageRoot]));
    expect(builds[1]).toEqual(expect.arrayContaining(["--tag", "wardby-coding-worker:local", packageRoot]));
    expect(calls.some((call) => call[1] === "pull")).toBe(false);
    const env = readQuickstartEnv(paths());
    expect(env.WARDBY_RUNTIME_IMAGE).toBe("wardby-runtime:local");
    expect(env.CODING_WORKER_IMAGE).toBe(BUILT_ID);
  });

  it("pulls the packaged Claude Code images by digest and writes them for claude-code", async () => {
    const claudeWorker = `ghcr.io/wardby/wardby-claude-coding-worker@sha256:${"4".repeat(64)}`;
    const claudeToolRunner = `ghcr.io/wardby/wardby-claude-tool-runner@sha256:${"5".repeat(64)}`;
    writeFileSync(
      join(packageRoot, "dist", "quickstart-images.json"),
      JSON.stringify({ runtime: RUNTIME, worker: WORKER, claudeWorker, claudeToolRunner }),
    );
    writeQuickstartEnv(paths(), { ANTHROPIC_API_KEY: "sk-ant" });
    const { deps, calls } = harness();
    await codingStep(
      paths(),
      state,
      { nonInteractive: true, coding: true, trust: [repoA], provider: "claude-code" },
      deps,
    );
    const pulled = calls.filter((call) => call[1] === "pull").map((call) => call[2]);
    expect(pulled).toEqual(expect.arrayContaining([RUNTIME, claudeWorker, claudeToolRunner]));
    // A Claude-only setup does not pull the Codex worker or point CODING_WORKER_IMAGE anywhere.
    expect(pulled).not.toContain(WORKER);
    const env = readQuickstartEnv(paths());
    expect(env.CODING_WORKER_IMAGE).toBeUndefined();
    expect(env.CODING_CLAUDE_WORKER_IMAGE).toBe(claudeWorker);
    expect(env.CODING_CLAUDE_TOOL_RUNNER_IMAGE).toBe(claudeToolRunner);
  });

  it("uses only the Claude env pair over a packaged install lacking Claude images", async () => {
    const claudeWorker = `ghcr.io/x/cw@sha256:${"6".repeat(64)}`;
    const claudeToolRunner = `ghcr.io/x/ct@sha256:${"7".repeat(64)}`;
    writeQuickstartEnv(paths(), { ANTHROPIC_API_KEY: "sk-ant" });
    const { deps } = harness({
      env: { CODING_CLAUDE_WORKER_IMAGE: claudeWorker, CODING_CLAUDE_TOOL_RUNNER_IMAGE: claudeToolRunner },
    });
    await codingStep(
      paths(),
      state,
      { nonInteractive: true, coding: true, trust: [repoA], provider: "claude-code" },
      deps,
    );
    const env = readQuickstartEnv(paths());
    expect(env.CODING_CLAUDE_WORKER_IMAGE).toBe(claudeWorker);
    expect(env.CODING_CLAUDE_TOOL_RUNNER_IMAGE).toBe(claudeToolRunner);
  });

  it("skips Claude Code with a clear message when only one Claude env var is set", async () => {
    writeQuickstartEnv(paths(), { ANTHROPIC_API_KEY: "sk-ant" });
    const { deps, logs } = harness({ env: { CODING_CLAUDE_WORKER_IMAGE: `ghcr.io/x/cw@sha256:${"6".repeat(64)}` } });
    const result = await codingStep(
      paths(),
      state,
      { nonInteractive: true, coding: true, trust: [repoA], provider: "claude-code" },
      deps,
    );
    expect(result).toBeNull();
    expect(logs.join("\n")).toMatch(/set both CODING_CLAUDE_WORKER_IMAGE and CODING_CLAUDE_TOOL_RUNNER_IMAGE/);
  });

  it("does not pull Claude Code images when the provider is codex", async () => {
    writeFileSync(
      join(packageRoot, "dist", "quickstart-images.json"),
      JSON.stringify({
        runtime: RUNTIME,
        worker: WORKER,
        claudeWorker: `ghcr.io/wardby/wardby-claude-coding-worker@sha256:${"4".repeat(64)}`,
        claudeToolRunner: `ghcr.io/wardby/wardby-claude-tool-runner@sha256:${"5".repeat(64)}`,
      }),
    );
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test" });
    const { deps, calls } = harness();
    await codingStep(paths(), state, { nonInteractive: true, coding: true, trust: [repoA] }, deps);
    expect(calls.some((call) => call.join(" ").includes("claude"))).toBe(false);
    expect(readQuickstartEnv(paths()).CODING_CLAUDE_WORKER_IMAGE).toBeUndefined();
  });

  it("builds the Claude Code images from a source checkout, pinned by local image id", async () => {
    rmSync(join(packageRoot, "dist", "quickstart-images.json"));
    mkdirSync(join(packageRoot, "deploy"));
    writeFileSync(join(packageRoot, "deploy", "Dockerfile"), "FROM scratch\n");
    mkdirSync(join(packageRoot, "src", "coding-worker"), { recursive: true });
    writeFileSync(join(packageRoot, "src", "coding-worker", "Dockerfile"), "FROM scratch\n");
    writeQuickstartEnv(paths(), { ANTHROPIC_API_KEY: "sk-ant" });
    const { deps, calls } = harness();
    await codingStep(
      paths(),
      state,
      { nonInteractive: true, coding: true, trust: [repoA], provider: "claude-code" },
      deps,
    );
    const tags = calls.filter((call) => call[1] === "build").map((call) => call[call.indexOf("--tag") + 1]);
    expect(tags).toEqual([
      "wardby-runtime:local",
      "wardby-claude-coding-worker:local",
      "wardby-claude-tool-runner:local",
    ]);
    const env = readQuickstartEnv(paths());
    // The Codex worker is optional on a Claude-only server; nothing builds or writes it.
    expect(env.CODING_WORKER_IMAGE).toBeUndefined();
    expect(env.CODING_CLAUDE_WORKER_IMAGE).toBe(BUILT_ID);
    expect(env.CODING_CLAUDE_TOOL_RUNNER_IMAGE).toBe(BUILT_ID);
  });

  it("preflights the Claude Code images it prepared, not a Codex worker", async () => {
    const claudeWorker = `ghcr.io/wardby/wardby-claude-coding-worker@sha256:${"4".repeat(64)}`;
    const claudeToolRunner = `ghcr.io/wardby/wardby-claude-tool-runner@sha256:${"5".repeat(64)}`;
    writeFileSync(
      join(packageRoot, "dist", "quickstart-images.json"),
      JSON.stringify({ runtime: RUNTIME, worker: WORKER, claudeWorker, claudeToolRunner }),
    );
    writeQuickstartEnv(paths(), { ANTHROPIC_API_KEY: "sk-ant" });
    const { deps, calls } = harness();
    await codingStep(
      paths(),
      state,
      { nonInteractive: true, coding: true, trust: [repoA], provider: "claude-code" },
      deps,
    );
    expect(calls).toContainEqual(["docker", "image", "inspect", claudeWorker]);
    expect(calls).toContainEqual(["docker", "image", "inspect", claudeToolRunner]);
    expect(calls.some((call) => call.includes(WORKER))).toBe(false);
  });

  it("drops a CODING_WORKER_IMAGE an earlier Claude-only run pointed at the Claude worker", async () => {
    const claudeWorker = `ghcr.io/wardby/wardby-claude-coding-worker@sha256:${"4".repeat(64)}`;
    const claudeToolRunner = `ghcr.io/wardby/wardby-claude-tool-runner@sha256:${"5".repeat(64)}`;
    writeFileSync(
      join(packageRoot, "dist", "quickstart-images.json"),
      JSON.stringify({ runtime: RUNTIME, worker: WORKER, claudeWorker, claudeToolRunner }),
    );
    const oldClaude = `sha256:${"8".repeat(64)}`;
    writeQuickstartEnv(paths(), {
      ANTHROPIC_API_KEY: "sk-ant",
      CODING_WORKER_IMAGE: oldClaude,
      CODING_CLAUDE_WORKER_IMAGE: oldClaude,
      CODING_CLAUDE_TOOL_RUNNER_IMAGE: `sha256:${"9".repeat(64)}`,
    });
    const { deps } = harness();
    await codingStep(
      paths(),
      state,
      { nonInteractive: true, coding: true, trust: [repoA], provider: "claude-code" },
      deps,
    );
    const env = readQuickstartEnv(paths());
    expect(env.CODING_WORKER_IMAGE).toBeUndefined();
    expect(env.CODING_CLAUDE_WORKER_IMAGE).toBe(claudeWorker);
  });

  it("keeps a Codex CODING_WORKER_IMAGE from an earlier Codex run when Claude Code is set up", async () => {
    const claudeWorker = `ghcr.io/wardby/wardby-claude-coding-worker@sha256:${"4".repeat(64)}`;
    const claudeToolRunner = `ghcr.io/wardby/wardby-claude-tool-runner@sha256:${"5".repeat(64)}`;
    writeFileSync(
      join(packageRoot, "dist", "quickstart-images.json"),
      JSON.stringify({ runtime: RUNTIME, worker: WORKER, claudeWorker, claudeToolRunner }),
    );
    writeQuickstartEnv(paths(), { ANTHROPIC_API_KEY: "sk-ant", CODING_WORKER_IMAGE: WORKER });
    const { deps, calls } = harness();
    await codingStep(
      paths(),
      state,
      { nonInteractive: true, coding: true, trust: [repoA], provider: "claude-code" },
      deps,
    );
    expect(readQuickstartEnv(paths()).CODING_WORKER_IMAGE).toBe(WORKER);
    expect(calls.filter((call) => call[1] === "pull").map((call) => call[2])).not.toContain(WORKER);
  });

  it("leaves Claude Code images from an earlier run untouched when Codex is set up", async () => {
    const claudeWorker = `sha256:${"4".repeat(64)}`;
    const claudeToolRunner = `sha256:${"5".repeat(64)}`;
    writeQuickstartEnv(paths(), {
      OPENAI_API_KEY: "sk-test",
      CODING_CLAUDE_WORKER_IMAGE: claudeWorker,
      CODING_CLAUDE_TOOL_RUNNER_IMAGE: claudeToolRunner,
    });
    const { deps, calls } = harness();
    await codingStep(paths(), state, { nonInteractive: true, coding: true, trust: [repoA], provider: "codex" }, deps);
    const env = readQuickstartEnv(paths());
    expect(env.CODING_WORKER_IMAGE).toBe(WORKER);
    expect(env.CODING_CLAUDE_WORKER_IMAGE).toBe(claudeWorker);
    expect(env.CODING_CLAUDE_TOOL_RUNNER_IMAGE).toBe(claudeToolRunner);
    expect(calls.filter((call) => call[1] === "pull").map((call) => call[2])).toEqual([RUNTIME, WORKER]);
  });

  it("builds only the runtime and coding worker for codex from a source checkout", async () => {
    rmSync(join(packageRoot, "dist", "quickstart-images.json"));
    mkdirSync(join(packageRoot, "deploy"));
    writeFileSync(join(packageRoot, "deploy", "Dockerfile"), "FROM scratch\n");
    mkdirSync(join(packageRoot, "src", "coding-worker"), { recursive: true });
    writeFileSync(join(packageRoot, "src", "coding-worker", "Dockerfile"), "FROM scratch\n");
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test" });
    const { deps, calls } = harness();
    await codingStep(paths(), state, { nonInteractive: true, coding: true, trust: [repoA], provider: "codex" }, deps);
    const tags = calls.filter((call) => call[1] === "build").map((call) => call[call.indexOf("--tag") + 1]);
    expect(tags).toEqual(["wardby-runtime:local", "wardby-coding-worker:local"]);
  });

  it("skips Claude Code when its images are not available", async () => {
    writeQuickstartEnv(paths(), { ANTHROPIC_API_KEY: "sk-ant" });
    const before = readFileSync(paths().envFile, "utf8");
    const { deps, logs, seeds } = harness();
    const result = await codingStep(
      paths(),
      state,
      { nonInteractive: true, coding: true, trust: [repoA], provider: "claude-code" },
      deps,
    );
    expect(result).toBeNull();
    expect(logs.join("\n")).toMatch(/Claude Code/);
    expect(readFileSync(paths().envFile, "utf8")).toBe(before);
    expect(seeds).toEqual([]);
  });

  it("lists a committed services.yaml, pre-pulls its images, and allows those services", async () => {
    commitServices(repoA, 'services:\n  postgres: "16"\n  redis: "7"\n');
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test" });
    const { deps, calls, logs, seeds, pulledServiceImages } = harness();
    await codingStep(paths(), state, { nonInteractive: true, coding: true, trust: [repoA] }, deps);
    expect(pulledServiceImages).toEqual([["postgres:16", "redis:7"]]);
    expect(calls).toContainEqual(["docker", "pull", `docker.io/library/postgres@sha256:${"9".repeat(64)}`]);
    expect(logs.join("\n")).toMatch(/postgres 16, redis 7/);
    expect(seeds[0].services).toEqual(["postgres", "redis"]);
  });

  it("continues past a service image that cannot be pulled", async () => {
    commitServices(repoA, 'services:\n  postgres: "16"\n');
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test" });
    const base = harness();
    const run = (command: string, args: string[]): CommandResult =>
      args[0] === "pull" && args[1].includes("postgres")
        ? { status: 1, stdout: "", stderr: "denied" }
        : base.deps.run(command, args);
    const { deps, logs, seeds } = harness({ run });
    await codingStep(paths(), state, { nonInteractive: true, coding: true, trust: [repoA] }, deps);
    expect(logs.join("\n")).toMatch(/could not pull/i);
    expect(seeds).toHaveLength(1);
  });

  it("prints the validation error for an invalid services.yaml and continues", async () => {
    commitServices(repoA, "databases:\n  postgres: 16\n");
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test" });
    const { deps, logs, seeds } = harness();
    await codingStep(paths(), state, { nonInteractive: true, coding: true, trust: [repoA] }, deps);
    expect(logs.join("\n")).toMatch(/only top-level keys allowed are `services` and `toolchain`/);
    expect(seeds).toHaveLength(1);
    expect(seeds[0].services).toEqual([]);
  });

  it("--starter-services commits a starter file onto its own branch without touching the work tree", async () => {
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test" });
    writeFileSync(join(repoA, "README.md"), "dirty\n");
    const status = gitIn(repoA, "--no-optional-locks", "status", "--porcelain");
    const { deps, logs, seeds } = harness();
    await codingStep(
      paths(),
      state,
      { nonInteractive: true, coding: true, trust: [repoA], starterServices: ["postgres", "redis"] },
      deps,
    );
    expect(gitIn(repoA, "show", "wardby/quickstart-services:.wardby/services.yaml")).toMatch(
      /services:\n {2}postgres: "16"\n {2}redis: "7"\n$/,
    );
    expect(gitIn(repoA, "--no-optional-locks", "status", "--porcelain")).toBe(status);
    expect(gitIn(repoA, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("main");
    expect(logs.join("\n")).toMatch(/wardby\/quickstart-services/);
    expect(logs.join("\n")).toMatch(/baseRef/);
    expect(seeds[0].services).toEqual(["postgres", "redis"]);
  });

  it("does not replace an existing starter branch non-interactively", async () => {
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test" });
    gitIn(repoA, "branch", "wardby/quickstart-services");
    const before = gitIn(repoA, "rev-parse", "wardby/quickstart-services");
    const { deps, logs } = harness();
    await codingStep(
      paths(),
      state,
      { nonInteractive: true, coding: true, trust: [repoA], starterServices: ["redis"] },
      deps,
    );
    expect(gitIn(repoA, "rev-parse", "wardby/quickstart-services")).toBe(before);
    expect(logs.join("\n")).toMatch(/already exists/);
  });

  it("seeds against the first trusted folder that is a repository", async () => {
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test" });
    const { deps, seeds } = harness();
    await codingStep(paths(), state, { nonInteractive: true, coding: true, trust: [folderB, repoA] }, deps);
    expect(seeds[0].repository).toBe(`local:${repoA}`);
  });
});

describe("codingStep (interactive)", () => {
  it("asks, trusts the current repository, and offers a starter file", async () => {
    writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test" });
    const questions: string[] = [];
    const answers = new Map<RegExp, string | boolean>([
      [/Set up coding/, true],
      [/Trust/, true],
      [/Add another/, ""],
      [/services\.yaml/, "p"],
    ]);
    const answer = (question: string) => {
      questions.push(question);
      for (const [pattern, value] of answers) if (pattern.test(question)) return value;
      throw new Error(`unexpected question: ${question}`);
    };
    const { deps, seeds } = harness({
      prompts: {
        line: async (question) => answer(question) as string,
        yesNo: async (question) => answer(question) as boolean,
        secret: async () => "unused",
      },
    });
    const result = await codingStep(paths(), state, { nonInteractive: false, trust: [] }, deps);
    expect(result?.roots).toEqual([repoA]);
    expect(seeds[0].services).toEqual(["postgres"]);
    expect(gitIn(repoA, "show", "wardby/quickstart-services:.wardby/services.yaml")).toMatch(/postgres: "16"/);
    expect(questions.some((question) => /Set up coding \+ review agents/.test(question))).toBe(true);
  });
});

describe("quickstart compose files", () => {
  it("adds the coding proxy file only once its runtime image is configured", () => {
    expect(quickstartComposeFiles("/pkg", {})).toEqual(["/pkg/deploy/local/docker-compose.yml"]);
    expect(quickstartComposeFiles("/pkg", { WARDBY_RUNTIME_IMAGE: RUNTIME })).toEqual([
      "/pkg/deploy/local/docker-compose.yml",
      "/pkg/deploy/local/docker-compose.quickstart-coding.yml",
    ]);
  });

  it("gives the proxy the same database credentials as the quickstart postgres service", () => {
    const repoRoot = join(import.meta.dirname, "..", "..");
    const coding = readFileSync(join(repoRoot, "deploy/local/docker-compose.quickstart-coding.yml"), "utf8");
    const base = readFileSync(join(repoRoot, "deploy/local/docker-compose.yml"), "utf8");
    expect(coding).toContain(
      "DATABASE_URL: postgresql://${WARDBY_POSTGRES_USER:-wardby}:${WARDBY_POSTGRES_PASSWORD:-wardby}@postgres:5432/${WARDBY_POSTGRES_DB:-wardby}",
    );
    for (const variable of [
      "${WARDBY_POSTGRES_USER:-wardby}",
      "${WARDBY_POSTGRES_PASSWORD:-wardby}",
      "${WARDBY_POSTGRES_DB:-wardby}",
    ]) {
      expect(base).toContain(variable);
    }
  });
});

describe("repositories under trusted folders", () => {
  const withCodex = () => writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test" });
  const run = (trust: string[], overrides: Partial<CodingDeps> = {}) => {
    const h = harness(overrides);
    return codingStep(paths(), state, { nonInteractive: true, coding: true, trust }, h.deps).then((result) => ({
      result,
      ...h,
    }));
  };

  it("uses the one repository directly under a trusted parent folder", async () => {
    withCodex();
    const parent = join(scratch, "parent");
    makeRepo(join(parent, "demo-app"));
    mkdirSync(join(parent, "notes"));
    const { result, seeds } = await run([parent]);
    expect(result?.repository).toBe(`local:${join(parent, "demo-app")}`);
    expect(seeds[0].repository).toBe(`local:${join(parent, "demo-app")}`);
  });

  it("still counts a trusted folder that is itself a repository", async () => {
    withCodex();
    const { result } = await run([repoA]);
    expect(result?.repository).toBe(`local:${repoA}`);
  });

  it("ignores hidden folders and symlinks that leave the trusted folder", async () => {
    withCodex();
    const parent = join(scratch, "parent");
    makeRepo(join(parent, ".hidden-repo"));
    const elsewhere = join(scratch, "elsewhere");
    makeRepo(join(elsewhere, "target"));
    // Sorts first; the target is trusted via another root, so only the containment guard skips it here.
    symlinkSync(join(elsewhere, "target"), join(parent, "aaa-linked"));
    makeRepo(join(parent, "real"));
    const { result } = await run([parent, elsewhere]);
    expect(result?.repository).toBe(`local:${join(parent, "real")}`);
  });

  it("non-interactive: takes the first of several in sorted order and says how to pick another", async () => {
    withCodex();
    const parent = join(scratch, "parent");
    makeRepo(join(parent, "zeta"));
    makeRepo(join(parent, "alpha"));
    const { result, logs } = await run([parent]);
    expect(result?.repository).toBe(`local:${join(parent, "alpha")}`);
    const text = logs.join("\n");
    expect(text).toContain(join(parent, "alpha"));
    expect(text).toContain(join(parent, "zeta"));
    expect(text).toMatch(/--trust <repo>/);
  });

  it("interactive: prompts to choose among several repositories", async () => {
    withCodex();
    const parent = join(scratch, "parent");
    makeRepo(join(parent, "zeta"));
    makeRepo(join(parent, "alpha"));
    const h = harness({
      prompts: {
        line: async (question) => (question.includes("Add another") ? "" : question.includes("Which") ? "2" : ""),
        yesNo: async () => false,
        secret: async () => "",
      },
    });
    const result = await codingStep(paths(), state, { nonInteractive: false, coding: true, trust: [parent] }, h.deps);
    expect(result?.repository).toBe(`local:${join(parent, "zeta")}`);
  });

  it("says no repository was found in or directly under the trusted folders", async () => {
    withCodex();
    const { result, logs } = await run([folderB]);
    expect(result?.repository).toBeUndefined();
    expect(logs.join("\n")).toMatch(/No git repository was found in or directly under the trusted folders/);
  });

  it("prefers this run's --trust folder over saved ones when re-run to pick another", async () => {
    withCodex();
    const parent = join(scratch, "parent");
    makeRepo(join(parent, "zeta"));
    makeRepo(join(parent, "alpha"));
    const first = await run([parent]);
    expect(first.result?.repository).toBe(`local:${join(parent, "alpha")}`);
    const second = await run([join(parent, "zeta")]);
    expect(second.result?.repository).toBe(`local:${join(parent, "zeta")}`);
  });
});

describe("codingStep with a Python repository", () => {
  const NP_WORKER = `ghcr.io/wardby/wardby-coding-worker-node-python@sha256:${"6".repeat(64)}`;
  const NP_TOOLS = `ghcr.io/wardby/wardby-claude-tool-runner-node-python@sha256:${"7".repeat(64)}`;
  const CLAUDE_WORKER = `ghcr.io/wardby/wardby-claude-coding-worker@sha256:${"4".repeat(64)}`;
  const CLAUDE_TOOLS = `ghcr.io/wardby/wardby-claude-tool-runner@sha256:${"5".repeat(64)}`;
  const WORKER_VAR = "CODING_WORKER_IMAGE_NODE_PYTHON_3_12";
  const TOOLS_VAR = "CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12";

  function commitPython(dir = repoA, name = "pyproject.toml"): void {
    writeFileSync(join(dir, name), "[project]\nname = 'x'\n");
    gitIn(dir, "add", name);
    gitIn(dir, "commit", "-q", "-m", "python");
  }
  function packageImages(extra: Record<string, string> = {}): void {
    writeFileSync(
      join(packageRoot, "dist", "quickstart-images.json"),
      JSON.stringify({
        runtime: RUNTIME,
        worker: WORKER,
        claudeWorker: CLAUDE_WORKER,
        claudeToolRunner: CLAUDE_TOOLS,
        ...extra,
      }),
    );
  }
  function sourceCheckout(): void {
    rmSync(join(packageRoot, "dist", "quickstart-images.json"));
    mkdirSync(join(packageRoot, "deploy"));
    writeFileSync(join(packageRoot, "deploy", "Dockerfile"), "FROM scratch\n");
    mkdirSync(join(packageRoot, "src", "coding-worker"), { recursive: true });
    writeFileSync(join(packageRoot, "src", "coding-worker", "Dockerfile"), "FROM scratch\n");
  }
  const step = (provider: "codex" | "claude-code", deps: CodingDeps) =>
    codingStep(paths(), state, { nonInteractive: true, coding: true, trust: [repoA], provider }, deps);
  const keys = () => writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test", ANTHROPIC_API_KEY: "sk-ant" });

  it("pulls the packaged Node + Python worker for Codex and selects the toolchain", async () => {
    commitPython();
    packageImages({ workerNodePython: NP_WORKER, claudeToolRunnerNodePython: NP_TOOLS });
    keys();
    const { deps, calls, seeds, logs } = harness();
    await step("codex", deps);
    const pulled = calls.filter((call) => call[1] === "pull").map((call) => call[2]);
    expect(pulled).toContain(NP_WORKER);
    expect(pulled).not.toContain(NP_TOOLS);
    const env = readQuickstartEnv(paths());
    expect(env[WORKER_VAR]).toBe(NP_WORKER);
    expect(env[TOOLS_VAR]).toBeUndefined();
    expect(seeds[0]).toMatchObject({ toolchain: "node-python", toolchainVersion: "3.12" });
    expect(logs).toContain("Python project detected: local-builder uses a Node + Python 3.12 workspace");
  });

  it("pulls the packaged Node + Python tool runner for Claude Code, not the Codex worker", async () => {
    commitPython(repoA, "requirements.txt");
    packageImages({ workerNodePython: NP_WORKER, claudeToolRunnerNodePython: NP_TOOLS });
    keys();
    const { deps, calls, seeds } = harness();
    await step("claude-code", deps);
    const pulled = calls.filter((call) => call[1] === "pull").map((call) => call[2]);
    expect(pulled).toContain(NP_TOOLS);
    expect(pulled).not.toContain(NP_WORKER);
    const env = readQuickstartEnv(paths());
    expect(env[TOOLS_VAR]).toBe(NP_TOOLS);
    expect(env[WORKER_VAR]).toBeUndefined();
    expect(seeds[0]).toMatchObject({ toolchain: "node-python", toolchainVersion: "3.12" });
  });

  it("leaves a non-Python repository on the Node workspace", async () => {
    packageImages({ workerNodePython: NP_WORKER, claudeToolRunnerNodePython: NP_TOOLS });
    keys();
    const { deps, calls, seeds, logs } = harness();
    await step("codex", deps);
    expect(calls.some((call) => call.includes(NP_WORKER))).toBe(false);
    expect(readQuickstartEnv(paths())[WORKER_VAR]).toBeUndefined();
    expect(seeds[0].toolchain ?? "node").toBe("node");
    expect(logs.join("\n")).not.toMatch(/Python project detected/);
  });

  it("keeps the Node workspace and says so when the release has no Python image", async () => {
    commitPython();
    packageImages();
    keys();
    const { deps, seeds, logs } = harness();
    await step("codex", deps);
    expect(seeds[0].toolchain ?? "node").toBe("node");
    expect(readQuickstartEnv(paths())[WORKER_VAR]).toBeUndefined();
    expect(logs.join("\n")).toContain(
      "Python project detected, but this version has no Python workspace image; the builder can edit code but not run Python tests. Upgrade, or set CODING_WORKER_IMAGE_NODE_PYTHON_3_12 / CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12",
    );
  });

  it("falls back to the Node workspace when the Python image cannot be pulled", async () => {
    commitPython();
    packageImages({ workerNodePython: NP_WORKER });
    keys();
    const { deps, seeds, logs } = harness({
      run: (command, args) => {
        if (args[0] === "pull" && args[1] === NP_WORKER) return { status: 1, stdout: "", stderr: "denied" };
        if (args[0] === "image" && args[1] === "inspect" && args.includes(NP_WORKER)) {
          return { status: 1, stdout: "", stderr: "" };
        }
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    const result = await step("codex", deps);
    expect(result?.seed).toBeDefined();
    expect(seeds[0].toolchain ?? "node").toBe("node");
    expect(readQuickstartEnv(paths())[WORKER_VAR]).toBeUndefined();
    expect(logs.join("\n")).toMatch(/could not pull/);
  });

  it("builds the Node + Python worker from a source checkout and pins it by local image id", async () => {
    commitPython();
    sourceCheckout();
    keys();
    const { deps, calls, seeds } = harness();
    await step("codex", deps);
    const build = calls.find((call) => call[1] === "build" && call.includes("wardby-coding-worker-node-python:local"))!;
    expect(build).toEqual(
      expect.arrayContaining(["--file", join(packageRoot, "src", "coding-worker", "Dockerfile.node-python")]),
    );
    expect(build).not.toContain("--target");
    expect(readQuickstartEnv(paths())[WORKER_VAR]).toBe(BUILT_ID);
    expect(seeds[0]).toMatchObject({ toolchain: "node-python", toolchainVersion: "3.12" });
  });

  it("builds the Node + Python tool runner with --target node-python for Claude Code", async () => {
    commitPython();
    sourceCheckout();
    keys();
    const { deps, calls } = harness();
    await step("claude-code", deps);
    const build = calls.find(
      (call) => call[1] === "build" && call.includes("wardby-claude-tool-runner-node-python:local"),
    )!;
    expect(build).toEqual(
      expect.arrayContaining([
        "--file",
        join(packageRoot, "src", "claude-tool-runner", "Dockerfile"),
        "--target",
        "node-python",
      ]),
    );
    expect(calls.some((call) => call.includes("wardby-coding-worker-node-python:local"))).toBe(false);
    expect(readQuickstartEnv(paths())[TOOLS_VAR]).toBe(BUILT_ID);
  });

  it("does not build the Python images for a non-Python repository in a source checkout", async () => {
    sourceCheckout();
    keys();
    const { deps, calls } = harness();
    await step("codex", deps);
    expect(calls.some((call) => call.join(" ").includes("node-python"))).toBe(false);
  });

  it("honors an env override over a source build", async () => {
    commitPython();
    sourceCheckout();
    keys();
    const { deps, calls, seeds } = harness({ env: { [WORKER_VAR]: NP_WORKER } });
    await step("codex", deps);
    expect(calls.some((call) => call[1] === "build" && call.join(" ").includes("node-python"))).toBe(false);
    expect(calls.filter((call) => call[1] === "pull").map((call) => call[2])).toContain(NP_WORKER);
    expect(readQuickstartEnv(paths())[WORKER_VAR]).toBe(NP_WORKER);
    expect(seeds[0]).toMatchObject({ toolchain: "node-python" });
  });

  it("does not detect Python from an uncommitted marker", async () => {
    packageImages({ workerNodePython: NP_WORKER });
    writeFileSync(join(repoA, "pyproject.toml"), "x\n");
    keys();
    const { deps, seeds } = harness();
    await step("codex", deps);
    expect(seeds[0].toolchain ?? "node").toBe("node");
  });
});

describe("codingStep offers the repository's declared packages", () => {
  function commitFiles(files: Record<string, string>): void {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(repoA, name), text);
    gitIn(repoA, "add", ...Object.keys(files));
    gitIn(repoA, "commit", "-q", "-m", "manifests");
  }
  const MANIFESTS = {
    "requirements.txt": "Flask>=3\npytest\n",
    "package.json": JSON.stringify({ dependencies: { express: "^4" }, devDependencies: { vitest: "^3" } }),
  };
  const nonInteractive = (deps: CodingDeps, allowRepoPackages?: boolean) =>
    codingStep(
      paths(),
      state,
      { nonInteractive: true, coding: true, trust: [repoA], provider: "codex", allowRepoPackages },
      deps,
    );
  function interactive(allowAnswer: boolean | undefined, allowRepoPackages?: boolean) {
    const questions: string[] = [];
    const answers = new Map<RegExp, string | boolean>([
      [/Set up coding/, true],
      [/Remove any/, ""],
      [/Trust/, true],
      [/Add another/, ""],
      [/services\.yaml/, "n"],
    ]);
    if (allowAnswer !== undefined) answers.set(/Allow local-builder to install/, allowAnswer);
    const answer = (question: string) => {
      questions.push(question);
      for (const [pattern, value] of answers) if (pattern.test(question)) return value;
      throw new Error(`unexpected question: ${question}`);
    };
    const h = harness({
      prompts: {
        line: async (question) => answer(question) as string,
        yesNo: async (question) => answer(question) as boolean,
        secret: async () => "unused",
      },
    });
    const run = () =>
      codingStep(paths(), state, { nonInteractive: false, trust: [], provider: "codex", allowRepoPackages }, h.deps);
    return { ...h, questions, run };
  }
  beforeEach(() => writeQuickstartEnv(paths(), { OPENAI_API_KEY: "sk-test" }));

  it("non-interactive: allows none without --allow-repo-packages and says how", async () => {
    commitFiles(MANIFESTS);
    const { deps, seeds, logs } = harness();
    await nonInteractive(deps);
    expect(seeds[0].packageAllowlist).toBeUndefined();
    expect(logs.join("\n")).toMatch(/--allow-repo-packages/);
    expect(logs.join("\n")).toMatch(/update_agent with codingProfile\.packageAllowlist/);
  });

  it("non-interactive: --allow-repo-packages allows the declared packages, Node and Python alike", async () => {
    commitFiles(MANIFESTS);
    const { deps, seeds, logs } = harness();
    await nonInteractive(deps, true);
    expect(seeds[0].packageAllowlist).toEqual({ npm: ["express", "vitest"], pypi: ["flask", "pytest"] });
    expect(logs).toContain("Packages declared on main: 2 npm, 2 PyPI");
    expect(logs.some((line) => line.startsWith("✓ local-builder may install"))).toBe(true);
  });

  it("a Node-only repository gets its npm packages", async () => {
    commitFiles({ "package.json": MANIFESTS["package.json"] });
    const { deps, seeds } = harness();
    await nonInteractive(deps, true);
    expect(seeds[0].packageAllowlist).toEqual({ npm: ["express", "vitest"] });
  });

  it("interactive: lists the packages and asks; yes allows them", async () => {
    commitFiles(MANIFESTS);
    const { seeds, logs, questions, run } = interactive(true);
    await run();
    expect(questions).toContain("Allow local-builder to install these packages through Wardby's registry?");
    expect(logs).toContain("  npm: express, vitest");
    expect(logs).toContain("  PyPI: flask, pytest");
    expect(seeds[0].packageAllowlist).toEqual({ npm: ["express", "vitest"], pypi: ["flask", "pytest"] });
  });

  it("interactive: no leaves the allowlist empty and says how to add packages later", async () => {
    commitFiles(MANIFESTS);
    const { seeds, logs, run } = interactive(false);
    await run();
    expect(seeds[0].packageAllowlist).toBeUndefined();
    expect(logs.join("\n")).toMatch(/update_agent with codingProfile\.packageAllowlist/);
  });

  it("interactive: --allow-repo-packages / --no-allow-repo-packages answer without asking", async () => {
    commitFiles(MANIFESTS);
    const yes = interactive(undefined, true);
    await yes.run();
    expect(yes.seeds[0].packageAllowlist).toEqual({ npm: ["express", "vitest"], pypi: ["flask", "pytest"] });
    const no = interactive(undefined, false);
    await no.run();
    expect(no.seeds[0].packageAllowlist).toBeUndefined();
  });

  it("shows about a dozen names and counts the rest", async () => {
    const names = Array.from({ length: 15 }, (_, i) => `pkg-${String(i).padStart(2, "0")}`);
    commitFiles({ "requirements.txt": names.join("\n") });
    const { deps, logs } = harness();
    await nonInteractive(deps, true);
    expect(logs).toContain(`  PyPI: ${names.slice(0, 12).join(", ")}`);
    expect(logs).toContain("  … and 3 more");
  });

  it("asks nothing and says nothing about packages when the repository declares none", async () => {
    const { seeds, logs, questions, run } = interactive(undefined);
    await run();
    expect(questions.some((question) => /install/.test(question))).toBe(false);
    expect(logs.some((line) => /[Pp]ackages/.test(line))).toBe(false);
    expect(seeds[0].packageAllowlist).toBeUndefined();
  });

  it("ignores manifests that are only in the working tree", async () => {
    for (const [name, text] of Object.entries(MANIFESTS)) writeFileSync(join(repoA, name), text);
    const { deps, seeds } = harness();
    await nonInteractive(deps, true);
    expect(seeds[0].packageAllowlist).toBeUndefined();
  });

  it("prints a manifest it could not read and offers the rest", async () => {
    commitFiles({ "pyproject.toml": "[project]\ndependencies = [\n", "requirements.txt": "flask\n" });
    const { deps, seeds, logs } = harness();
    await nonInteractive(deps, true);
    expect(logs.some((line) => line.startsWith("! Could not read the dependencies in pyproject.toml"))).toBe(true);
    expect(seeds[0].packageAllowlist).toEqual({ pypi: ["flask"] });
  });
});
