import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deriveRegistryToken } from "../coding/registry/token.js";
import type { CodingTaskInput } from "../coding/protocol.js";
import { CODING_OUTPUT_JSON_SCHEMA, runCodingWorker, WORKER_SECURITY_INSTRUCTIONS } from "./driver.js";
import type { WorkerClientConfig, WorkerEvent, WorkerThread } from "./types.js";

async function tempWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "wardby-driver-"));
}

const input: CodingTaskInput = {
  schemaVersion: 1,
  runId: "run_123",
  repository: "openai/example",
  baseRef: "main",
  headRef: "wardby/run-run_123",
  task: "Fix the failing test.",
  model: "gpt-5.6-luna",
  budgetUsd: 1,
  deadlineAt: "2026-09-07T13:00:00.000Z",
};

async function* events(values: WorkerEvent[]) {
  yield* values;
}

function clientFor(values: WorkerEvent[], capture: { config?: WorkerClientConfig; thread?: unknown; prompt?: string }) {
  return (config: WorkerClientConfig) => {
    capture.config = config;
    return {
      startThread(options: unknown) {
        capture.thread = options;
        return {
          async runStreamed(prompt: string) {
            capture.prompt = prompt;
            return { events: events(values) };
          },
        } as WorkerThread;
      },
    };
  };
}

describe("runCodingWorker", () => {
  it("pins the model, workspace sandbox, proxy capability, and immutable developer policy", async () => {
    const capture: { config?: WorkerClientConfig; thread?: unknown; prompt?: string } = {};
    const progress = vi.fn();
    const workspace = await tempWorkspace();
    const output = JSON.stringify({
      schemaVersion: 1,
      runId: input.runId,
      outcome: "changes_ready",
      summary: "Fixed the test.",
      tests: [{ command: "npm test", outcome: "passed" }],
    });
    const result = await runCodingWorker({
      input,
      workspace,
      proxyBaseUrl: "http://proxy:8080",
      capability: "rrp_worker_capability",
      signal: new AbortController().signal,
      createClient: clientFor(
        [
          { type: "turn.started" },
          { type: "item.started", item: { type: "command_execution", status: "in_progress" } },
          { type: "item.started", item: { type: input.task, status: "SECRET_PROVIDER_STATUS" } },
          { type: "item.completed", item: { type: "agent_message", status: "completed", text: output } },
          { type: "turn.completed" },
        ],
        capture,
      ),
      onProgress: progress,
    });

    expect(result.outcome).toBe("changes_ready");
    expect(capture.config).toMatchObject({
      proxyBaseUrl: "http://proxy:8080",
      capability: "rrp_worker_capability",
      developerInstructions: WORKER_SECURITY_INSTRUCTIONS,
      environment: expect.objectContaining({
        HOME: "/home/wardby",
        LANG: "C.UTF-8",
        PATH: "/usr/local/bin:/usr/bin:/bin",
        TMPDIR: "/tmp",
        npm_config_registry: "http://proxy:8080/registry/npm/",
      }),
    });
    expect(capture.thread).toEqual({
      model: input.model,
      sandboxMode: "danger-full-access",
      workingDirectory: workspace,
      skipGitRepoCheck: true,
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      approvalPolicy: "never",
    });
    expect(capture.prompt).toContain(input.task);
    expect(WORKER_SECURITY_INSTRUCTIONS).toContain("AGENTS.md");
    expect(JSON.stringify(progress.mock.calls)).not.toContain(input.task);
    expect(JSON.stringify(progress.mock.calls)).not.toContain("npm test");
    expect(JSON.stringify(progress.mock.calls)).not.toContain("SECRET_PROVIDER_STATUS");
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ type: "activity", kind: "other" }));
  });

  it("points npm and pip at the proxy with the registry token, never the capability", async () => {
    const workspace = await tempWorkspace();
    const capability = "rrp_worker_capability";
    const proxyBaseUrl = "http://proxy:8080";
    const capture: { config?: WorkerClientConfig } = {};
    const output = JSON.stringify({
      schemaVersion: 1,
      runId: input.runId,
      outcome: "no_changes",
      summary: "None.",
      tests: [],
    });
    await runCodingWorker({
      input,
      workspace,
      proxyBaseUrl,
      capability,
      signal: new AbortController().signal,
      createClient: clientFor([{ type: "item.completed", item: { type: "agent_message", text: output } }], capture),
    });

    const env = capture.config!.environment;
    expect(env.npm_config_registry).toBe(`${proxyBaseUrl}/registry/npm/`);
    expect(env.PIP_INDEX_URL).toContain(deriveRegistryToken(capability));
    expect(JSON.stringify(env)).not.toContain(capability);
    expect(await readFile(join(workspace, ".cache", "npm", "npmrc"), "utf8")).toContain("_authToken=rrg_");
  });

  it("rewrites proxy tarball URLs in collected npm lockfiles back to the public registry", async () => {
    const workspace = await tempWorkspace();
    const proxied = `{\n  "resolved": "http://proxy:8080/registry/npm/-/tarball/%40react-aria%2Flive-announcer/3.5.1"\n}\n`;
    const output = JSON.stringify({
      schemaVersion: 1,
      runId: input.runId,
      outcome: "changes_ready",
      summary: "Added a dependency.",
      tests: [],
    });
    await runCodingWorker({
      input,
      workspace,
      proxyBaseUrl: "http://proxy:8080",
      capability: "cap",
      signal: new AbortController().signal,
      createClient: () => ({
        startThread: () => ({
          async runStreamed() {
            // What `npm install` leaves behind in a subdirectory during the agent's turn.
            await mkdir(join(workspace, "web"));
            await writeFile(join(workspace, "web", "package-lock.json"), proxied);
            return { events: events([{ type: "item.completed", item: { type: "agent_message", text: output } }]) };
          },
        }),
      }),
    });

    expect(await readFile(join(workspace, "web", "package-lock.json"), "utf8")).toBe(
      `{\n  "resolved": "https://registry.npmjs.org/@react-aria/live-announcer/-/live-announcer-3.5.1.tgz"\n}\n`,
    );
  });

  it("rejects a structured result bound to another run", async () => {
    const output = JSON.stringify({
      schemaVersion: 1,
      runId: "run_other",
      outcome: "no_changes",
      summary: "None.",
      tests: [],
    });
    await expect(
      runCodingWorker({
        input,
        workspace: await tempWorkspace(),
        proxyBaseUrl: "http://proxy",
        capability: "cap",
        signal: new AbortController().signal,
        createClient: clientFor([{ type: "item.completed", item: { type: "agent_message", text: output } }], {}),
      }),
    ).rejects.toThrow("coding_output_run_mismatch");
  });

  it("returns a bounded budget result without reflecting provider errors", async () => {
    const result = await runCodingWorker({
      input,
      workspace: await tempWorkspace(),
      proxyBaseUrl: "http://proxy",
      capability: "cap",
      signal: new AbortController().signal,
      createClient: clientFor(
        [{ type: "turn.failed", error: { message: "wardby_budget_exhausted SECRET_PROVIDER_BODY" } }],
        {},
      ),
    });
    expect(result).toMatchObject({ runId: input.runId, outcome: "budget_exhausted", tests: [] });
    expect(JSON.stringify(result)).not.toContain("SECRET_PROVIDER_BODY");
  });

  it("redacts the per-run proxy capability from structured results", async () => {
    const capability = `rrp_${"A".repeat(43)}`;
    const output = JSON.stringify({
      schemaVersion: 1,
      runId: input.runId,
      outcome: "changes_ready",
      summary: `Completed with ${capability}`,
      tests: [{ command: `echo ${capability}`, outcome: "passed" }],
    });
    const result = await runCodingWorker({
      input,
      workspace: await tempWorkspace(),
      proxyBaseUrl: "http://proxy",
      capability,
      signal: new AbortController().signal,
      createClient: clientFor([{ type: "item.completed", item: { type: "agent_message", text: output } }], {}),
    });

    expect(JSON.stringify(result)).not.toContain(capability);
    expect(result.summary).toContain("[REDACTED]");
    expect(result.tests[0]?.command).toContain("[REDACTED]");
  });

  it("fails closed when Codex emits no valid terminal output", async () => {
    await expect(
      runCodingWorker({
        input,
        workspace: await tempWorkspace(),
        proxyBaseUrl: "http://proxy",
        capability: "cap",
        signal: new AbortController().signal,
        createClient: clientFor([{ type: "turn.failed", error: { message: "raw upstream failure" } }], {}),
      }),
    ).rejects.toThrow("coding_turn_failed");
  });

  it("reports a fixed code when the Codex event stream terminates unexpectedly", async () => {
    const createClient = () => ({
      startThread: () => ({
        runStreamed: async () => ({
          events: (async function* () {
            yield { type: "turn.started" } as WorkerEvent;
            throw new Error("provider detail must not escape");
          })(),
        }),
      }),
    });

    await expect(
      runCodingWorker({
        input,
        workspace: await tempWorkspace(),
        proxyBaseUrl: "http://proxy",
        capability: "cap",
        signal: new AbortController().signal,
        createClient,
      }),
    ).rejects.toThrow("coding_stream_failed");
  });

  it("reports a fixed code when structured output violates the worker schema", async () => {
    await expect(
      runCodingWorker({
        input,
        workspace: await tempWorkspace(),
        proxyBaseUrl: "http://proxy",
        capability: "cap",
        signal: new AbortController().signal,
        createClient: clientFor(
          [{ type: "item.completed", item: { type: "agent_message", text: '{"unexpected":"value"}' } }],
          {},
        ),
      }),
    ).rejects.toThrow("coding_output_invalid");
  });
});

describe("CODING_OUTPUT_JSON_SCHEMA", () => {
  it("marks every property required with a nullable type for tag, per OpenAI's strict Structured Outputs rules", () => {
    // additionalProperties:false + strict mode requires every key in "properties" to appear in
    // "required" — optionality is expressed via a nullable type, never by omitting the key.
    // Getting this wrong (tag was once absent from "required") makes OpenAI reject every request
    // with an HTTP 400 before the model runs at all, regardless of whether a tag is even relevant.
    expect(CODING_OUTPUT_JSON_SCHEMA.required).toEqual(Object.keys(CODING_OUTPUT_JSON_SCHEMA.properties));
    expect(CODING_OUTPUT_JSON_SCHEMA.properties.tag).toMatchObject({ type: ["string", "null"] });
    expect(CODING_OUTPUT_JSON_SCHEMA.properties.tag.description).toContain("32 characters");
  });
});
