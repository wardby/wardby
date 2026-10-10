import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { BUILTIN_CODING_SERVICES } from "../../coding/services/builtins.js";
import { resolvedFromDefinition } from "../../coding/services/catalog.js";
import { DockerJobLauncher } from "./docker.js";
import {
  assertClaudeAgentContainerInspection,
  assertClaudeToolRunnerContainerInspection,
  isolationNames,
  type DockerContainerInspection,
} from "./docker-isolation.js";
import { claudeToolSetup } from "./claude-tool-setup.js";
import type { JobHandle, JobSpec } from "./types.js";

const execute = promisify(execFile);
const enabled = process.env.WARDBY_CLAUDE_DOCKER_TEST === "1";
const agentImage = process.env.WARDBY_CLAUDE_WORKER_IMAGE ?? "";
const toolImage = process.env.WARDBY_CLAUDE_TOOL_RUNNER_IMAGE ?? "";
// An operator-style tool runner built FROM the release tool runner (src/claude-tool-runner/Dockerfile.custom-example).
const customToolImage = process.env.WARDBY_CLAUDE_CUSTOM_TOOL_RUNNER_IMAGE ?? "";
const token = `${process.pid}-${Date.now()}`;
const capability = "rrp_0123456789abcdef";

async function keeperProbe(container: string): Promise<string> {
  const run = async (label: string, args: string[]): Promise<string> => {
    try {
      const output = await docker(args);
      return `${label}:ok:${JSON.stringify(output.slice(0, 256))}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `${label}:failed:${JSON.stringify(message.slice(0, 512))}`;
    }
  };
  return [
    await run("state", [
      "container",
      "inspect",
      "--format",
      "{{.State.Status}}/{{.State.ExitCode}}/{{.State.OOMKilled}}",
      container,
    ]),
    await run("logs", ["container", "logs", "--tail", "8", container]),
    await run("node_default_user", [
      "container",
      "exec",
      "--workdir",
      "/",
      container,
      "node",
      "-e",
      "process.stdout.write('exec_ok')",
    ]),
    await run("node_exec", [
      "container",
      "exec",
      "--user",
      "10001:10001",
      "--workdir",
      "/",
      container,
      "node",
      "-e",
      "process.stdout.write('exec_ok')",
    ]),
    await run("tar_exec", [
      "container",
      "exec",
      "--user",
      "10001:10001",
      "--workdir",
      "/",
      container,
      "tar",
      "--version",
    ]),
  ].join(";");
}

async function docker(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const result = await execute("docker", args, {
      encoding: "utf8",
      env: { ...process.env, ...env },
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    const details = error as Error & { stderr?: string; stdout?: string };
    throw new Error([details.message, details.stderr, details.stdout].filter(Boolean).join("\n"), { cause: error });
  }
}

async function cleanup(args: string[]): Promise<void> {
  try {
    await docker(args);
  } catch {
    // Docker cleanup must remain safe after a failed adversarial probe.
  }
}

function fakeProxyProgram(): string {
  return String.raw`
const http = require('node:http');
const text = process.env.FAKE_RESULT;
// Through the npm shim: two Node processes plus npm must fit in the tool runner's PID limit.
const TOOL_INPUT = { command: process.env.FAKE_TOOL_COMMAND || 'printf "%s\\n" "$npm_config_registry"; npm --version', timeout_ms: 30000 };
let turn = 0;
function toolSse(id, name, input) { return [
  { type: 'message_start', message: { id: 'msg_wardby_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 7 } },
  { type: 'message_stop' },
].map((frame) => 'event: ' + frame.type + '\\ndata: ' + JSON.stringify(frame) + '\\n\\n').join(''); }
http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  let body;
  try { body = JSON.parse(raw); } catch {}
  console.log(JSON.stringify({ method: request.method, url: request.url, stream: body?.stream, messages: body?.messages, lastMessage: body?.messages?.at(-1), validCapability: request.headers['x-api-key'] === process.env.EXPECTED_CAPABILITY }));
  if (request.method === 'HEAD' && request.url === '/api/hello') return response.writeHead(200, { 'cache-control': 'no-store' }).end();
  if (request.method === 'POST' && request.url === '/v1/messages?beta=true') {
    if (body?.stream === false) {
      const structured = turn > 1;
      const id = structured ? 'toolu_structured_docker' : 'toolu_wardby_docker';
      const name = structured ? 'StructuredOutput' : 'mcp__wardby_tools__run_command';
      const input = structured ? JSON.parse(text) : TOOL_INPUT;
      return response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({
        id: 'msg_wardby_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
        content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use', stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 7 },
      }));
    }
    const payload = turn++ === 0
      ? toolSse('toolu_wardby_docker', 'mcp__wardby_tools__run_command', TOOL_INPUT)
      : toolSse('toolu_structured_docker', 'StructuredOutput', JSON.parse(text));
    return response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }).end(payload);
  }
  response.writeHead(404).end();
}).listen(8787, '0.0.0.0');
`;
}

interface SmokeCase {
  runId: string;
  proxy: string;
  toolImage: string;
  /** The command the fake model asks run_command to run; the default exercises the npm shim. */
  toolCommand?: string;
  /** Whether a run_command result text is the one this case expects. */
  toolResult: (text: string) => boolean;
  root?: string;
}

async function cleanupSmoke(smoke: SmokeCase): Promise<void> {
  const names = isolationNames(smoke.runId);
  await cleanup(["container", "rm", "--force", names.workerContainer]);
  await cleanup(["container", "rm", "--force", names.toolContainer]);
  await cleanup(["container", "rm", "--force", names.keeperContainer]);
  await cleanup(["network", "rm", names.network]);
  await cleanup(["volume", "rm", names.storageVolume]);
  await cleanup(["container", "rm", "--force", smoke.proxy]);
  if (smoke.root) await rm(smoke.root, { recursive: true, force: true });
}

/** Launches the production agent and the given tool runner through DockerJobLauncher and drives one run_command. */
async function runSmoke(smoke: SmokeCase): Promise<void> {
  const { runId, proxy } = smoke;
  const names = isolationNames(runId);
  let failedKeeperProbe: string | undefined;
  const root = await mkdtemp(join(tmpdir(), "wardby-claude-docker-"));
  smoke.root = root;
  const workspace = join(root, "workspaces", runId, "workspace");
  const git = join(root, "workspaces", runId, "git");
  const input = join(root, "input.json");
  const output = { schemaVersion: 1, runId, outcome: "no_changes", summary: "fixture", tests: [], tag: "fixture" };
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(git, { recursive: true })]);
  await Promise.all([
    writeFile(join(workspace, "README.md"), "fixture\n"),
    writeFile(join(git, "HEAD"), "ref: refs/heads/main\n"),
    writeFile(
      input,
      JSON.stringify({
        schemaVersion: 1,
        runId,
        repository: "wardby/fixture",
        baseRef: "main",
        headRef: `wardby/run-${runId}`,
        task: "Return the required structured result without making changes.",
        model: "claude-sonnet-5",
        budgetUsd: 0.25,
        deadlineAt: new Date(Date.now() + 90_000).toISOString(),
      }),
    ),
  ]);
  await docker([
    "container",
    "create",
    "--name",
    proxy,
    "--network",
    "bridge",
    "--env",
    `EXPECTED_CAPABILITY=${capability}`,
    "--env",
    `FAKE_RESULT=${JSON.stringify(output)}`,
    ...(smoke.toolCommand ? ["--env", `FAKE_TOOL_COMMAND=${smoke.toolCommand}`] : []),
    "--entrypoint",
    "node",
    agentImage,
    "-e",
    fakeProxyProgram(),
  ]);
  await docker(["container", "start", proxy]);

  const launcher = new DockerJobLauncher({
    stateRoot: join(root, "state"),
    workspaceRoot: join(root, "workspaces"),
    proxyContainer: proxy,
    resolveCapability: async () => capability,
    isRunActive: async () => false,
    onProvisionFailure: async ({ keeperContainer }) => {
      if (process.env.WARDBY_CLAUDE_KEEPER_PROBE === "1") failedKeeperProbe = await keeperProbe(keeperContainer);
    },
  });
  const spec: JobSpec = {
    kind: "coding-agent",
    provider: "claude-code",
    runId,
    image: agentImage,
    toolImage: smoke.toolImage,
    inputArtifact: input,
    timeoutSec: 90,
    limits: { cpus: 1, memoryMb: 512, pids: 128, diskMb: 64 },
    labels: {},
  };
  let handle: JobHandle;
  try {
    handle = await launcher.launch(spec);
  } catch (error) {
    if (error instanceof Error && failedKeeperProbe)
      throw new Error(`${error.message}:keeper_probe=${failedKeeperProbe}`, { cause: error });
    throw error;
  }
  const [agent, tool] = await Promise.all([
    docker(["container", "inspect", names.workerContainer]).then(
      (value) => JSON.parse(value)[0] as DockerContainerInspection,
    ),
    docker(["container", "inspect", names.toolContainer]).then(
      (value) => JSON.parse(value)[0] as DockerContainerInspection,
    ),
  ]);
  assertClaudeAgentContainerInspection(agent, spec, capability);
  assertClaudeToolRunnerContainerInspection(tool, spec, claudeToolSetup(spec, capability));
  expect((tool as DockerContainerInspection & { State?: { Running?: boolean } }).State?.Running).toBe(true);

  let status = await launcher.status(handle);
  for (let attempt = 0; attempt < 800 && (status.state === "pending" || status.state === "running"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    status = await launcher.status(handle);
  }
  if (status.state === "failed") {
    throw new Error(
      `claude_agent_failed:${await docker(["container", "logs", names.workerContainer])}:proxy:${await docker(["container", "logs", proxy])}`,
    );
  }
  expect(status).toEqual({ state: "succeeded" });
  expect(await launcher.collect(handle)).toEqual({
    exitCode: 0,
    reason: "completed",
    resultArtifact: JSON.stringify(output),
  });
  const proxyEvents = (await docker(["container", "logs", proxy]))
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          method: string;
          url: string;
          validCapability: boolean;
          lastMessage?: { role: string; content: Array<Record<string, unknown>> };
          messages?: Array<{ role: string; content: unknown }>;
        },
    );
  expect(proxyEvents).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ method: "HEAD", url: "/api/hello", validCapability: false }),
      expect.objectContaining({ method: "POST", url: "/v1/messages?beta=true", validCapability: true }),
    ]),
  );
  expect(proxyEvents.every((event) => event.method === "HEAD" || event.validCapability)).toBe(true);
  const messageEvents = proxyEvents.filter((event) => event.url === "/v1/messages?beta=true");
  expect(messageEvents.length).toBeGreaterThanOrEqual(2);
  expect(
    messageEvents.some((event) =>
      event.messages?.some(
        (message) =>
          message.role === "user" &&
          Array.isArray(message.content) &&
          message.content.some(
            (block) =>
              block.type === "tool_result" &&
              block.tool_use_id === "toolu_wardby_docker" &&
              Array.isArray(block.content) &&
              block.content.some(
                (part: { text?: unknown }) => typeof part.text === "string" && smoke.toolResult(part.text),
              ) &&
              JSON.stringify(block.cache_control) === JSON.stringify({ type: "ephemeral" }),
          ),
      ),
    ),
  ).toBe(true);
  await launcher.remove(handle);
  await expect(launcher.status(handle)).rejects.toThrow("job_removed");
}

describe.skipIf(!enabled || !agentImage || !toolImage)("Claude Docker acceptance", () => {
  const smoke: SmokeCase = {
    runId: `claude-docker-smoke-${token}`,
    proxy: `wardby-claude-job-proxy-${token}`,
    toolImage,
    toolResult: (text) =>
      text.startsWith("exit_code=0\n") &&
      text.includes("http://wardby-proxy:8787/registry/npm/\n") &&
      /^\d+\.\d+\.\d+$/m.test(text),
  };

  afterAll(() => cleanupSmoke(smoke), 30_000);

  it("runs the production agent and tool runner with only their reviewed capabilities", () => runSmoke(smoke), 120_000);
});

describe.skipIf(!enabled || !agentImage || !customToolImage)(
  "Claude Docker acceptance with a custom tool runner",
  () => {
    const smoke: SmokeCase = {
      runId: `claude-docker-custom-${token}`,
      proxy: `wardby-claude-custom-proxy-${token}`,
      toolImage: customToolImage,
      // The added tool, then the run's workspace: only the tool runner has both (the agent has no repo).
      toolCommand: "wardby-custom-tool && cat README.md",
      toolResult: (text) => text.startsWith("exit_code=0\n") && text.includes("wardby-custom-tool-ok\nfixture\n"),
    };

    afterAll(() => cleanupSmoke(smoke), 30_000);

    it(
      "runs the agent's commands in a tool runner built FROM the release image, under the same isolation checks",
      () => runSmoke(smoke),
      120_000,
    );
  },
);

const servicesRunId = `claude-docker-services-${token}`;
const servicesProxy = `wardby-claude-services-proxy-${token}`;
const servicesNames = isolationNames(servicesRunId);
const POSTGRES = resolvedFromDefinition(
  BUILTIN_CODING_SERVICES.find((service) => service.name === "postgres" && service.version === "16")!,
);
// Runs in the tool runner. Prints fixed words only, never a variable's value.
const SERVICES_PROBE = [
  'const net = require("node:net");',
  "const probe = (host, port) => new Promise((done) => {",
  "const socket = net.connect({ host, port }); socket.setTimeout(3000);",
  'socket.once("connect", () => { socket.destroy(); done(true); });',
  'socket.once("timeout", () => { socket.destroy(); done(false); });',
  'socket.once("error", () => done(false)); });',
  'Promise.all([probe("127.0.0.1", 5432), probe("wardby-proxy", 8787), probe("1.1.1.1", 443)]).then(([pg, proxy, direct]) => {',
  'console.log(pg ? "postgres_reachable" : "postgres_unreachable");',
  'console.log(proxy ? "proxy_reachable" : "proxy_unreachable");',
  'console.log(direct ? "direct_egress_open" : "direct_egress_blocked");',
  "process.exitCode = pg && proxy && !direct ? 0 : 1; });",
].join(" ");
const SERVICES_TOOL_COMMAND = `node -e '${SERVICES_PROBE}' && test -n "$DATABASE_URL" && echo database_url_set`;

function runFilters(id: string): string[] {
  return [
    "--filter",
    "label=io.wardby.managed=true",
    "--filter",
    `label=io.wardby.run-sha256=${createHash("sha256").update(id).digest("hex")}`,
  ];
}

/** Every managed container, network and volume still labelled for the run. */
async function leftovers(id: string): Promise<string[]> {
  const listed = await Promise.all([
    docker(["container", "ls", "--all", "--quiet", ...runFilters(id)]),
    docker(["network", "ls", "--quiet", ...runFilters(id)]),
    docker(["volume", "ls", "--quiet", ...runFilters(id)]),
  ]);
  return listed.join("\n").split("\n").filter(Boolean);
}

async function sweep(id: string): Promise<void> {
  const lines = async (args: string[]) => (await docker(args).catch(() => "")).split("\n").filter(Boolean);
  for (const container of await lines(["container", "ls", "--all", "--quiet", ...runFilters(id)])) {
    await cleanup(["container", "rm", "--force", "--volumes", container]);
  }
  await cleanup(["network", "disconnect", "--force", isolationNames(id).network, servicesProxy]);
  for (const network of await lines(["network", "ls", "--quiet", ...runFilters(id)])) {
    await cleanup(["network", "rm", network]);
  }
  for (const volume of await lines(["volume", "ls", "--quiet", ...runFilters(id)])) {
    await cleanup(["volume", "rm", "--force", volume]);
  }
}

describe.skipIf(!enabled || !agentImage || !toolImage)("Claude Docker acceptance with services", () => {
  let servicesRoot: string | undefined;

  afterAll(async () => {
    await sweep(servicesRunId);
    await cleanup(["container", "rm", "--force", servicesProxy]);
    if (servicesRoot) await rm(servicesRoot, { recursive: true, force: true });
  }, 60_000);

  it("gives the tool runner postgres on 127.0.0.1 and the proxy, nothing else, and keeps the agent off the keeper", async () => {
    servicesRoot = await mkdtemp(join(tmpdir(), "wardby-claude-docker-services-"));
    const workspace = join(servicesRoot, "workspaces", servicesRunId, "workspace");
    const git = join(servicesRoot, "workspaces", servicesRunId, "git");
    const input = join(servicesRoot, "input.json");
    const output = {
      schemaVersion: 1,
      runId: servicesRunId,
      outcome: "no_changes",
      summary: "fixture",
      tests: [],
      tag: "fixture",
    };
    await Promise.all([mkdir(workspace, { recursive: true }), mkdir(git, { recursive: true })]);
    await Promise.all([
      writeFile(join(workspace, "README.md"), "fixture\n"),
      writeFile(join(git, "HEAD"), "ref: refs/heads/main\n"),
      writeFile(
        input,
        JSON.stringify({
          schemaVersion: 1,
          runId: servicesRunId,
          repository: "wardby/fixture",
          baseRef: "main",
          headRef: `wardby/run-${servicesRunId}`,
          task: "Return the required structured result without making changes.",
          model: "claude-sonnet-5",
          budgetUsd: 0.25,
          deadlineAt: new Date(Date.now() + 240_000).toISOString(),
        }),
      ),
    ]);
    await docker([
      "container",
      "create",
      "--name",
      servicesProxy,
      "--network",
      "bridge",
      "--env",
      `EXPECTED_CAPABILITY=${capability}`,
      "--env",
      `FAKE_RESULT=${JSON.stringify(output)}`,
      "--env",
      `FAKE_TOOL_COMMAND=${SERVICES_TOOL_COMMAND}`,
      "--entrypoint",
      "node",
      agentImage,
      "-e",
      fakeProxyProgram(),
    ]);
    await docker(["container", "start", servicesProxy]);

    const launcher = new DockerJobLauncher({
      stateRoot: join(servicesRoot, "state"),
      workspaceRoot: join(servicesRoot, "workspaces"),
      proxyContainer: servicesProxy,
      resolveCapability: async () => capability,
      isRunActive: async () => false,
    });
    const spec: JobSpec = {
      kind: "coding-agent",
      provider: "claude-code",
      runId: servicesRunId,
      image: agentImage,
      toolImage,
      inputArtifact: input,
      timeoutSec: 240,
      limits: { cpus: 1, memoryMb: 512, pids: 128, diskMb: 64 },
      labels: {},
      services: [POSTGRES],
    };
    const handle = await launcher.launch(spec);
    const inspectOne = async (name: string) =>
      JSON.parse(await docker(["container", "inspect", name]))[0] as DockerContainerInspection;
    const [agent, tool, keeper] = await Promise.all([
      inspectOne(servicesNames.workerContainer),
      inspectOne(servicesNames.toolContainer),
      inspectOne(servicesNames.networkKeeperContainer),
    ]);
    // The agent is on the run network only; the tool runner is in the keeper's namespace only.
    assertClaudeAgentContainerInspection(agent, spec, capability);
    assertClaudeToolRunnerContainerInspection(tool, spec, claudeToolSetup(spec, capability), keeper.Id);
    expect(Object.keys(tool.NetworkSettings?.Networks ?? {})).toEqual([]);

    let status = await launcher.status(handle);
    for (let attempt = 0; attempt < 1_200 && (status.state === "pending" || status.state === "running"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = await launcher.status(handle);
    }
    if (status.state === "failed") {
      throw new Error(
        `claude_agent_failed:${await docker(["container", "logs", servicesNames.workerContainer])}:proxy:${await docker(["container", "logs", servicesProxy])}`,
      );
    }
    expect(status).toEqual({ state: "succeeded" });
    expect(await launcher.collect(handle)).toEqual({
      exitCode: 0,
      reason: "completed",
      resultArtifact: JSON.stringify(output),
    });

    const proxyLog = await docker(["container", "logs", servicesProxy]);
    const toolResults = proxyLog
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        const event = JSON.parse(line) as { messages?: Array<{ role: string; content: unknown }> };
        return (event.messages ?? []).flatMap((message) =>
          Array.isArray(message.content)
            ? (message.content as Array<{ type?: string; tool_use_id?: string; content?: Array<{ text?: unknown }> }>)
                .filter((block) => block.type === "tool_result" && block.tool_use_id === "toolu_wardby_docker")
                .flatMap((block) =>
                  (block.content ?? []).map((part) => (typeof part.text === "string" ? part.text : "")),
                )
            : [],
        );
      });
    expect(
      toolResults.some(
        (text) =>
          text.startsWith("exit_code=0\n") &&
          text.includes("postgres_reachable") &&
          text.includes("proxy_reachable") &&
          text.includes("direct_egress_blocked") &&
          text.includes("database_url_set"),
      ),
    ).toBe(true);
    // No service variable's value ever reaches the model's transcript.
    expect(proxyLog).not.toContain(POSTGRES.testEnv.DATABASE_URL);

    await launcher.remove(handle);
    expect(await leftovers(servicesRunId)).toEqual([]);
  }, 300_000);
});
