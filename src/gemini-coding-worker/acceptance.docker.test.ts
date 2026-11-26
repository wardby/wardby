// The Gemini CLI worker image under the real Docker launcher (read-only root, tmpfs home, internal
// network, isolation attestation), with wardby-sim's scripted model behind the real coding proxy, on
// both backends (AI Studio and Vertex). The launcher has no gemini-cli provider yet, so the image
// runs in the Codex shape (JobSpec.provider unset), which is this worker's shape. Fake values only.
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createModelService, MODEL_PREFIX } from "../../tools/wardby-sim/src/model/service.js";
import { simRequest } from "../../tools/wardby-sim/src/server.js";
import { parseCodingWorkerOutputJson } from "../coding/protocol.js";
import { createSimulatorModelFetch, loadTestSimulators } from "../config/test-simulators.js";
import { VERTEX_CREDENTIAL_REF } from "../providers/coding-proxy/gemini-upstream.js";
import { MemoryProxyLedger } from "../providers/coding-proxy/memory-ledger.js";
import { CodingProxy } from "../providers/coding-proxy/proxy.js";
import { startCodingProxyServer } from "../providers/coding-proxy/server.js";
import type { ProxyAuditEvent } from "../providers/coding-proxy/types.js";
import { DockerJobLauncher } from "../providers/jobs/docker.js";
import { CODING_PROXY_PORT, isolationNames } from "../providers/jobs/docker-isolation.js";
import type { JobSpec } from "../providers/jobs/types.js";
import { shippedCatalog } from "../providers/llm/catalog.js";
import { entryOf } from "../providers/llm/catalog-types.js";
import { GEMINI_DOCKER_ENABLED, GEMINI_IMAGE } from "./docker.test-support.js";

const execute = promisify(execFile);
const docker = async (args: string[]) => (await execute("docker", args, { encoding: "utf8" })).stdout.trim();
const token = `${process.pid}-${Date.now()}`;
const forwarder = `wardby-gemini-proxy-${token}`;
const service = createModelService();
let simServer: ReturnType<typeof createServer>;
let simBase: string;
let root: string;
/** The launcher runs only an immutable image (a digest or a local image ID), never a tag. */
let imageId: string;

const FIXED = "export function sum(a, b) {\n  return a + b;\n}\n";
const answer = JSON.stringify({
  schemaVersion: 1,
  runId: "{{runId}}",
  outcome: "changes_ready",
  summary: "Fix sum() to add its arguments; `node --test` passes.",
  tag: null,
  commitType: "fix",
  commitScope: "sum",
  commitTitle: "add instead of subtract in sum",
  pullRequest: null,
  tests: [{ command: "node --test", outcome: "passed" }],
});

beforeAll(async () => {
  if (!GEMINI_DOCKER_ENABLED) return;
  simServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const url = new URL(req.url ?? "/", "http://sim.invalid");
        const path = url.pathname.startsWith(MODEL_PREFIX) ? url.pathname.slice(MODEL_PREFIX.length) : url.pathname;
        const response = (await service.handle(
          simRequest(req.method ?? "GET", `${path}${url.search}`, Buffer.concat(chunks)),
          {} as never,
        )) ?? { status: 404, body: "" };
        res.writeHead(response.status, response.headers).end(response.body);
      })().catch(() => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
    });
  });
  await new Promise<void>((resolve) => simServer.listen(0, "127.0.0.1", resolve));
  simBase = `http://127.0.0.1:${(simServer.address() as AddressInfo).port}`;
  root = await mkdtemp(join(tmpdir(), "wardby-gemini-acceptance-"));
  imageId = await docker(["image", "inspect", "--format", "{{.Id}}", GEMINI_IMAGE]);
});
afterAll(async () => {
  if (!GEMINI_DOCKER_ENABLED) return;
  simServer.close();
  await docker(["container", "rm", "--force", forwarder]).catch(() => "");
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(!GEMINI_DOCKER_ENABLED)("Gemini CLI worker under the Docker launcher against wardby-sim", () => {
  it("bakes no WARDBY_* variable (the launcher attests the worker's exact WARDBY_* environment)", async () => {
    const env = JSON.parse(await docker(["image", "inspect", "--format", "{{json .Config.Env}}", imageId])) as string[];
    expect(env.filter((value) => value.startsWith("WARDBY_"))).toEqual([]);
  });

  it.each(["google-ai-studio.gemini-4-neon", "us.gemini-4-neon"])(
    "%s: fixes the bug, runs the tests and answers through the real proxy",
    async (model) => {
      const runId = `gemini-accept-${model.startsWith("us.") ? "vertex" : "studio"}`;
      await service.actions!["model.load"](
        {
          scripts: [
            {
              agent: runId,
              protocol: "gemini-generate-content",
              match: `The final JSON runId must be ${runId}.`,
              turns: [
                {
                  parts: [
                    { functionCall: { id: "c1", name: "write_file", args: { file_path: "sum.js", content: FIXED } } },
                  ],
                },
                {
                  parts: [
                    {
                      functionCall: {
                        id: "c2",
                        name: "run_shell_command",
                        args: { command: "node --test", description: "Run the tests" },
                      },
                    },
                  ],
                },
                { parts: [{ text: answer }] },
              ],
            },
          ],
        },
        { state: {} as never },
      );
      const entry = entryOf(shippedCatalog().require(model));
      const audit: ProxyAuditEvent[] = [];
      const sims = loadTestSimulators({ WARDBY_TEST_SIMULATORS: "1", WARDBY_SIM_BASE_URL: simBase })!;
      const proxy = new CodingProxy({
        ledger: new MemoryProxyLedger(),
        credentials: { resolve: async () => "AIzaFAKEacceptanceKEY0123456789abcdEF" },
        fetch: createSimulatorModelFetch(sims, () => new Error("blocked")),
        audit: (event) => audit.push(event),
        gemini: { vertexProject: "example-project", vertexToken: async () => "ya29.FAKEacceptance" },
      });
      const session = await proxy.createSession({
        runId,
        credentialRef: entry.provider === "vertex-gemini" ? VERTEX_CREDENTIAL_REF : "env:GEMINI_API_KEY",
        protocol: "gemini-generate-content",
        allowedModels: [model],
        deadlineAt: new Date(Date.now() + 600_000),
        budgetUsd: 5,
        terms: { version: "acceptance", entry },
      });
      const server = await startCodingProxyServer(proxy, { host: "0.0.0.0", port: 0 });
      try {
        // The launcher attaches a "proxy container" to the run's internal network; this one forwards to the in-process proxy.
        await docker(["container", "rm", "--force", forwarder]).catch(() => "");
        await docker([
          "container",
          "run",
          "--detach",
          "--name",
          forwarder,
          "--network",
          "bridge",
          "--add-host",
          "host.docker.internal:host-gateway",
          "--entrypoint",
          "node",
          GEMINI_IMAGE,
          "-e",
          `require("node:net").createServer((c)=>{const u=require("node:net").connect(${server.port},"host.docker.internal");c.pipe(u);u.pipe(c);u.on("error",()=>c.destroy());c.on("error",()=>u.destroy());}).listen(${CODING_PROXY_PORT},"0.0.0.0")`,
        ]);
        const workspace = join(root, "workspaces", runId, "workspace");
        await mkdir(join(root, "workspaces", runId, "git"), { recursive: true });
        await mkdir(workspace, { recursive: true });
        await writeFile(join(root, "workspaces", runId, "git", "HEAD"), "ref: refs/heads/main\n");
        await writeFile(join(workspace, "package.json"), '{ "type": "module" }\n');
        await writeFile(join(workspace, "sum.js"), "export function sum(a, b) {\n  return a - b;\n}\n");
        await writeFile(
          join(workspace, "sum.test.js"),
          'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sum } from "./sum.js";\ntest("adds", () => assert.equal(sum(2, 3), 5));\n',
        );
        const input = join(root, `${runId}.json`);
        await writeFile(
          input,
          JSON.stringify({
            schemaVersion: 1,
            runId,
            repository: "your-org/your-repo",
            baseRef: "main",
            headRef: `wardby/run-${runId}`,
            task: "Fix sum() so the tests pass.",
            model,
            budgetUsd: 5,
            deadlineAt: new Date(Date.now() + 600_000).toISOString(),
          }),
        );
        const launcher = new DockerJobLauncher({
          stateRoot: join(root, "state"),
          workspaceRoot: join(root, "workspaces"),
          proxyContainer: forwarder,
          resolveCapability: async () => session.capability,
          isRunActive: async () => false,
        });
        const spec: JobSpec = {
          kind: "coding-agent",
          runId,
          image: imageId,
          inputArtifact: input,
          timeoutSec: 300,
          limits: { cpus: 2, memoryMb: 2048, pids: 256, diskMb: 1024 },
          labels: {},
        };
        const handle = await launcher.launch(spec);
        let status = await launcher.status(handle);
        for (let i = 0; i < 600 && (status.state === "pending" || status.state === "running"); i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          status = await launcher.status(handle);
        }
        const collected = await launcher.collect(handle);
        expect(status, JSON.stringify(collected)).toEqual({ state: "succeeded" });
        const result = parseCodingWorkerOutputJson(collected.resultArtifact!);
        expect(result).toMatchObject({
          runId,
          outcome: "changes_ready",
          tests: [{ command: "node --test", outcome: "passed" }],
        });
        const { served } = (await service.actions!["model.served"]({}, { state: {} as never })) as {
          served: { agent: string; turn: number }[];
        };
        expect(served.filter((s) => s.agent === runId).map((s) => s.turn)).toEqual([0, 1, 2]);
        expect(audit.filter((e) => e.type === "request.rejected")).toEqual([]);
        await launcher.remove(handle);
      } finally {
        await server.close();
        const names = isolationNames(runId);
        for (const name of [names.workerContainer, names.keeperContainer]) {
          await docker(["container", "rm", "--force", name]).catch(() => "");
        }
        await docker(["network", "rm", names.network]).catch(() => "");
        await docker(["volume", "rm", names.storageVolume]).catch(() => "");
      }
    },
    600_000,
  );
});
