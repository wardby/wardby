import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { DockerJobLauncher } from "./docker.js";
import {
  assertClaudeAgentContainerInspection,
  assertClaudeToolRunnerContainerInspection,
  isolationNames,
  type DockerContainerInspection,
} from "./docker-isolation.js";
import type { JobHandle, JobSpec } from "./types.js";

const execute = promisify(execFile);
const enabled = process.env.REEVO_CLAUDE_DOCKER_TEST === "1";
const agentImage = process.env.REEVO_CLAUDE_WORKER_IMAGE ?? "";
const toolImage = process.env.REEVO_CLAUDE_TOOL_RUNNER_IMAGE ?? "";
const token = `${process.pid}-${Date.now()}`;
const runId = `claude-docker-smoke-${token}`;
const proxy = `reevo-claude-job-proxy-${token}`;
const capability = "rrp_0123456789abcdef";
const names = isolationNames(runId);
let root: string | undefined;

async function keeperProbe(container: string): Promise<string> {
  const run = async (label: string, args: string[]): Promise<string> => {
    try {
      const output = await docker(args);
      return `${label}:ok:${JSON.stringify(output.slice(0, 256))}`;
    } catch {
      return `${label}:failed`;
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
let turn = 0;
function toolSse(id, name, input) { return [
  { type: 'message_start', message: { id: 'msg_reevo_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 0 } } },
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
      const id = structured ? 'toolu_structured_docker' : 'toolu_reevo_docker';
      const name = structured ? 'StructuredOutput' : 'mcp__reevo_tools__run_command';
      const input = structured ? JSON.parse(text) : { command: 'git status --short', timeout_ms: 1000 };
      return response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({
        id: 'msg_reevo_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-5',
        content: [{ type: 'tool_use', id, name, input }], stop_reason: 'tool_use', stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 7 },
      }));
    }
    const payload = turn++ === 0
      ? toolSse('toolu_reevo_docker', 'mcp__reevo_tools__run_command', { command: 'git status --short', timeout_ms: 1000 })
      : toolSse('toolu_structured_docker', 'StructuredOutput', JSON.parse(text));
    return response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' }).end(payload);
  }
  response.writeHead(404).end();
}).listen(8787, '0.0.0.0');
`;
}

describe.skipIf(!enabled || !agentImage || !toolImage)("Claude Docker acceptance", () => {
  let failedKeeperProbe: string | undefined;

  afterAll(async () => {
    await cleanup(["container", "rm", "--force", names.workerContainer]);
    await cleanup(["container", "rm", "--force", names.toolContainer]);
    await cleanup(["container", "rm", "--force", names.keeperContainer]);
    await cleanup(["network", "rm", names.network]);
    await cleanup(["volume", "rm", names.storageVolume]);
    await cleanup(["container", "rm", "--force", proxy]);
    if (root) await rm(root, { recursive: true, force: true });
  }, 30_000);

  it("runs the production agent and tool runner with only their reviewed capabilities", async () => {
    root = await mkdtemp(join(tmpdir(), "reevo-claude-docker-"));
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
          repository: "reevo/fixture",
          baseRef: "main",
          headRef: `reevo/run-${runId}`,
          task: "Return the required structured result without making changes.",
          model: "claude-sonnet-5",
          budgetUsd: 0.25,
          deadlineAt: new Date(Date.now() + 30_000).toISOString(),
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
        if (process.env.REEVO_CLAUDE_KEEPER_PROBE === "1") failedKeeperProbe = await keeperProbe(keeperContainer);
      },
    });
    const spec: JobSpec = {
      kind: "coding-agent",
      provider: "claude-code",
      runId,
      image: agentImage,
      toolImage,
      inputArtifact: input,
      timeoutSec: 30,
      limits: { cpus: 1, memoryMb: 512, pids: 64, diskMb: 64 },
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
    assertClaudeToolRunnerContainerInspection(tool, spec);
    expect((tool as DockerContainerInspection & { State?: { Running?: boolean } }).State?.Running).toBe(true);

    let status = await launcher.status(handle);
    for (let attempt = 0; attempt < 80 && (status.state === "pending" || status.state === "running"); attempt += 1) {
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
            message.role === "system" &&
            typeof message.content === "string" &&
            message.content.includes("Today's date"),
        ),
      ),
    ).toBe(true);
    expect(
      messageEvents.some((event) =>
        event.messages?.some(
          (message) =>
            message.role === "user" &&
            Array.isArray(message.content) &&
            message.content.some(
              (block) =>
                block.type === "tool_result" &&
                block.tool_use_id === "toolu_reevo_docker" &&
                JSON.stringify(block.cache_control) === JSON.stringify({ type: "ephemeral" }),
            ),
        ),
      ),
    ).toBe(true);
    await launcher.remove(handle);
    await expect(launcher.status(handle)).rejects.toThrow("job_removed");
  }, 45_000);
});
