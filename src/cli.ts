#!/usr/bin/env node
/**
 * Minimal CLI.
 *
 *   wardby agent create --name <n> --model <m> --prompt <p> --budget <usd> [--schedule "<cron>"] [--timezone <tz>] [--memory-enabled]
 *   wardby agent list
 *   wardby agent schedule <name> --cron "<expr>" [--timezone <tz>] [--disable]
 *   wardby run <name>
 *   wardby runs [--agent <name>] [--limit N] [--status <s>]
 *   wardby scheduler [--scope default]
 *   wardby mcp   (MCP_TRANSPORT=stdio|http selects the transport; authoring/
 *                control is MCP-first from here — this floor keeps working
 *                before/without an MCP client)
 *   wardby serve [--scope default]   (everything: mcp + scheduler + reconciler; the
 *                                    image's default command, and what a
 *                                    single-container deployment should run)
 */

import "./env.js";
import { readFileSync } from "node:fs";
import { execFile as execFileCallback } from "node:child_process";
import { parseArgs } from "node:util";
import { promisify } from "node:util";
import type { RunStatus } from "@prisma/client";
import {
  loadCodingConcurrencyConfig,
  loadContainerExecutorConfig,
  loadKubernetesJobConfig,
  loadProviderConfig,
} from "./config/providers.js";
import { drainCodingQueue } from "./core/coding-queue.js";
import { isImmutableDockerImage } from "./providers/jobs/docker-isolation.js";
import { ClientNodeKubernetesApi } from "./providers/jobs/kubernetes-client.js";
import { kubernetesPreflight } from "./providers/jobs/kubernetes-preflight.js";
import { RoutingLlmProvider, resolveLlmRegistrations } from "./providers/llm/index.js";
import { buildConfiguredExecutor, buildExecutor } from "./providers/executor/index.js";
import type { Executor } from "./providers/executor/types.js";
import { PostgresDatastore } from "./providers/datastore/index.js";
import { PostgresAgentMemory } from "./providers/memory/index.js";
import { buildSecretCipher } from "./providers/secrets/index.js";
import type { ProviderRegistry } from "./providers/index.js";
import { prisma } from "./core/db.js";
import { runAgent } from "./core/runner.js";
import { validateCronExpression } from "./core/cron.js";
import { startScheduler } from "./core/scheduler.js";
import { startReconciler } from "./core/reconciler.js";
import { NativeEngine } from "./core/engine-native.js";
import { logger } from "./core/logger.js";
import { deriveJsonSchema } from "./sandbox/zod-params.js";
import { ToolCapabilitiesPatchSchema } from "./sandbox/tool-capabilities.js";
import { startMcp } from "./mcp/index.js";
import { startServe } from "./serve.js";
import { authCommand } from "./mcp/auth/self-hosted/cli.js";
import { parseImportArgs } from "./import/cli-args.js";
import { runImport } from "./import/index.js";

const cliLog = logger.child({ module: "cli" });

const RUN_STATUSES: RunStatus[] = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "refused",
  "lost",
  "budget_exhausted",
  "cancelled",
];
const execFile = promisify(execFileCallback);

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function buildLlmProvider(): ProviderRegistry["llm"] {
  const result = resolveLlmRegistrations();
  if (result.kind === "no-credentials") {
    fail("No LLM credentials present. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, and/or BEDROCK_REGION (or AWS_REGION).");
  }
  return new RoutingLlmProvider(result.registrations);
}

function buildEngine(): ProviderRegistry["engine"] {
  const config = loadProviderConfig();
  if (config.engine !== "native") {
    fail(`ENGINE "${config.engine}" has no adapter yet (only "native").`);
  }
  return new NativeEngine();
}

function buildDatastore(cipher: ProviderRegistry["secrets"]): ProviderRegistry["datastore"] {
  const config = loadProviderConfig();
  if (config.datastore !== "postgres") {
    fail(`DATASTORE "${String(config.datastore)}" has no adapter yet (only "postgres").`);
  }
  return new PostgresDatastore(prisma, cipher);
}

function buildMemory(): ProviderRegistry["memory"] {
  return new PostgresAgentMemory(prisma);
}

function buildSecrets(): ProviderRegistry["secrets"] {
  const config = loadProviderConfig();
  try {
    return buildSecretCipher(config);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
}

async function agentCreate(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: "string" },
      model: { type: "string" },
      prompt: { type: "string" },
      budget: { type: "string" },
      schedule: { type: "string" },
      timezone: { type: "string" },
      "max-turns": { type: "string" },
      "memory-enabled": { type: "boolean" },
    },
  });

  if (!values.name || !values.model || !values.prompt || !values.budget) {
    fail("agent create requires --name, --model, --prompt, and --budget.");
  }

  const budgetUsd = Number(values.budget);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) {
    fail(`--budget must be a positive number, got "${values.budget}".`);
  }

  const maxTurns = values["max-turns"] ? Number(values["max-turns"]) : 10;
  if (!Number.isInteger(maxTurns) || maxTurns <= 0) {
    fail(`--max-turns must be a positive integer, got "${values["max-turns"]}".`);
  }

  const timezone = values.timezone ?? "UTC";
  if (values.schedule) {
    try {
      validateCronExpression(values.schedule, timezone);
    } catch (err) {
      fail(`invalid --schedule/--timezone: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const agent = await prisma.agent.create({
    data: {
      name: values.name,
      model: values.model,
      systemPrompt: values.prompt,
      budgetUsd,
      schedule: values.schedule ?? null,
      timezone,
      maxTurns,
      memoryEnabled: values["memory-enabled"] ?? false,
    },
  });
  console.log(agent.id);
}

async function toolCreate(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      name: { type: "string" },
      description: { type: "string" },
      params: { type: "string" },
      code: { type: "string" },
    },
  });

  if (!values.name || !values.description || !values.params || !values.code) {
    fail("tool create requires --name, --description, --params <file>, and --code <file>.");
  }

  let paramsZod: string;
  let code: string;
  try {
    paramsZod = readFileSync(values.params, "utf8");
  } catch (err) {
    fail(`could not read --params file "${values.params}": ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    code = readFileSync(values.code, "utf8");
  } catch (err) {
    fail(`could not read --code file "${values.code}": ${err instanceof Error ? err.message : String(err)}`);
  }

  // Fails at registration, not at call time: a malformed schema never gets
  // persisted. The derived schema is cached on the row (no "update tool"
  // path exists, so it can never go stale) rather than re-derived per run.
  const schemaResult = await deriveJsonSchema(paramsZod!);
  if (!schemaResult.ok) {
    fail(`invalid --params schema: ${schemaResult.errorMessage}`);
  }

  const tool = await prisma.tool.create({
    data: {
      name: values.name,
      description: values.description,
      paramsZod: paramsZod!,
      jsonSchema: schemaResult.value as object,
      code: code!,
    },
  });
  console.log(tool.id);
}

async function toolAttach(args: string[], detach: boolean): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "allow-secret": { type: "string", multiple: true },
      "allow-datastore-prefix": { type: "string", multiple: true },
      "allow-host": { type: "string", multiple: true },
      // "<boundName>:<prefix>" — repeatable, one prefix per flag; grouped
      // below into { [boundName]: prefix[] }, mirroring how
      // allow-datastore-prefix maps to the agent's own private store.
      "allow-shared-datastore-prefix": { type: "string", multiple: true },
    },
  });
  const [toolName, agentName] = positionals;
  if (!toolName || !agentName) {
    fail(`tool ${detach ? "detach" : "attach"} requires <tool-name> <agent-name>.`);
  }

  const tool = await prisma.tool.findUnique({ where: { name: toolName } });
  if (!tool) fail(`unknown tool "${toolName}".`);
  const agent = await prisma.agent.findUnique({ where: { name: agentName } });
  if (!agent) fail(`unknown agent "${agentName}".`);

  if (detach) {
    await prisma.agentTool.deleteMany({ where: { agentId: agent.id, toolId: tool.id } });
    console.log(`detached "${toolName}" from "${agentName}".`);
    return;
  }

  let allowedSharedDatastorePrefixes: Record<string, string[]> | undefined;
  if (values["allow-shared-datastore-prefix"]) {
    allowedSharedDatastorePrefixes = {};
    for (const entry of values["allow-shared-datastore-prefix"]) {
      const sep = entry.indexOf(":");
      if (sep < 0) {
        fail(`invalid --allow-shared-datastore-prefix "${entry}" — expected "<boundName>:<prefix>".`);
      }
      const boundName = entry.slice(0, sep);
      const prefix = entry.slice(sep + 1);
      (allowedSharedDatastorePrefixes[boundName] ??= []).push(prefix);
    }
  }

  const patch = ToolCapabilitiesPatchSchema.safeParse({
    allowedSecrets: values["allow-secret"],
    allowedDatastorePrefixes: values["allow-datastore-prefix"],
    allowedHosts: values["allow-host"],
    allowedSharedDatastorePrefixes,
  });
  if (!patch.success) {
    fail(`invalid tool capabilities: ${patch.error.issues.map((i) => i.message).join("; ")}`);
  }

  await prisma.agentTool.upsert({
    where: { agentId_toolId: { agentId: agent.id, toolId: tool.id } },
    create: {
      agentId: agent.id,
      toolId: tool.id,
      allowedSecrets: patch.data.allowedSecrets ?? [],
      allowedDatastorePrefixes: patch.data.allowedDatastorePrefixes ?? [],
      allowedHosts: patch.data.allowedHosts ?? [],
      allowedSharedDatastorePrefixes: patch.data.allowedSharedDatastorePrefixes ?? {},
    },
    update: {
      ...(patch.data.allowedSecrets !== undefined ? { allowedSecrets: patch.data.allowedSecrets } : {}),
      ...(patch.data.allowedDatastorePrefixes !== undefined
        ? { allowedDatastorePrefixes: patch.data.allowedDatastorePrefixes }
        : {}),
      ...(patch.data.allowedHosts !== undefined ? { allowedHosts: patch.data.allowedHosts } : {}),
      ...(patch.data.allowedSharedDatastorePrefixes !== undefined
        ? { allowedSharedDatastorePrefixes: patch.data.allowedSharedDatastorePrefixes }
        : {}),
    },
  });
  console.log(`attached "${toolName}" to "${agentName}".`);
}

async function toolList(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { agent: { type: "string" } } });

  if (values.agent) {
    const agent = await prisma.agent.findUnique({ where: { name: values.agent } });
    if (!agent) fail(`unknown agent "${values.agent}".`);
    const attached = await prisma.agentTool.findMany({ where: { agentId: agent.id }, include: { tool: true } });
    if (attached.length === 0) {
      console.log(`no tools attached to "${values.agent}".`);
      return;
    }
    for (const a of attached) console.log(`${a.tool.name}  ${a.tool.description}`);
    return;
  }

  const tools = await prisma.tool.findMany({ orderBy: { name: "asc" } });
  if (tools.length === 0) {
    console.log("no tools registered.");
    return;
  }
  for (const t of tools) console.log(`${t.name}  ${t.description}`);
}

async function agentSchedule(args: string[]): Promise<void> {
  const [name, ...rest] = args;
  if (!name) {
    fail('agent schedule requires an agent name: wardby agent schedule <name> --cron "<expr>"');
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      cron: { type: "string" },
      timezone: { type: "string" },
      disable: { type: "boolean" },
    },
  });

  const agent = await prisma.agent.findUnique({ where: { name: name } });
  if (!agent) {
    fail(`unknown agent "${name}".`);
  }

  if (values.disable) {
    await prisma.agent.update({ where: { name: name }, data: { scheduleEnabled: false } });
    console.log(`schedule disabled for "${name}".`);
    return;
  }

  const timezone = values.timezone ?? agent.timezone;
  const schedule = values.cron ?? agent.schedule;
  if (!schedule) {
    fail("no --cron given and the agent has no existing schedule to re-enable.");
  }

  try {
    validateCronExpression(schedule, timezone);
  } catch (err) {
    fail(`invalid --cron/--timezone: ${err instanceof Error ? err.message : String(err)}`);
  }

  await prisma.agent.update({
    where: { name: name },
    data: { schedule, timezone, scheduleEnabled: true },
  });
  console.log(`schedule set for "${name}": "${schedule}" (${timezone}).`);
}

async function agentList(): Promise<void> {
  const agents = await prisma.agent.findMany({ orderBy: { name: "asc" } });
  if (agents.length === 0) {
    console.log("no agents registered.");
    return;
  }

  for (const agent of agents) {
    const schedule = agent.schedule
      ? `${agent.scheduleEnabled ? "enabled" : "disabled"}: ${agent.schedule} (${agent.timezone})`
      : "manual";
    console.log(
      `${agent.name}  ${agent.kind.padEnd(6)}  ${agent.model}  ` +
        `$${Number(agent.budgetUsd).toFixed(4)}  ${agent.maxTurns} turns  memory ${agent.memoryEnabled ? "on" : "off"}  ${schedule}`,
    );
  }
}

async function run(name: string | undefined): Promise<void> {
  if (!name) {
    fail("run requires an agent name: wardby run <name>");
  }

  const agent = await prisma.agent.findUnique({ where: { name } });
  if (!agent) fail(`unknown agent "${name}".`);
  if (agent.kind === "coding") {
    fail("Coding agents are MCP-first: use trigger_agent so task input and ownership are recorded safely.");
  }

  const llm = buildLlmProvider();
  const engine = buildEngine();
  const secrets = buildSecrets();
  const datastore = buildDatastore(secrets);
  const memory = buildMemory();

  let run;
  try {
    run = await runAgent(name, { llm, engine, datastore, secrets, memory }, prisma, (delta) => {
      process.stdout.write(delta);
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  process.stdout.write("\n");

  const completedAgent = await prisma.agent.findUnique({ where: { id: run.agentId } });
  const budgetUsd = completedAgent ? Number(completedAgent.budgetUsd) : NaN;

  if (run.status === "succeeded" || run.status === "budget_exhausted") {
    const marker = run.status === "succeeded" ? "✓" : "◐";
    console.log(
      `${marker} run ${run.id} (${run.status}) — ${run.tokensIn} in / ${run.tokensOut} out — ` +
        `$${Number(run.costUsd).toFixed(6)} (budget $${budgetUsd.toFixed(4)})`,
    );
    if (run.status === "budget_exhausted") process.exitCode = 1;
  } else {
    console.error(`✗ run ${run.id} — ${run.status}: ${run.error ?? "unknown error"}`);
    process.exitCode = 1;
  }
}

function noopExecutor(): Executor {
  return { async start() {}, async stop() {} };
}

async function codingOps(args: string[]): Promise<void> {
  const [operation, ...rest] = args;
  const config = loadProviderConfig();
  if (config.jobs !== "docker" && config.jobs !== "kubernetes") {
    fail("coding operations require JOB_LAUNCHER=docker or kubernetes.");
  }
  const container = loadContainerExecutorConfig();
  if (config.jobs === "kubernetes") {
    if (!container.workerImage) fail("CODING_WORKER_IMAGE is required when JOB_LAUNCHER=kubernetes.");
  } else if (!container.workerImage || !container.proxyContainer) {
    fail("CODING_WORKER_IMAGE and CODING_PROXY_CONTAINER are required when JOB_LAUNCHER=docker.");
  }

  if (operation === "preflight" && config.jobs === "kubernetes") {
    const kubernetes = loadKubernetesJobConfig();
    const api = new ClientNodeKubernetesApi({ context: kubernetes.context });
    let checks: string[];
    try {
      checks = await kubernetesPreflight({ api, config: kubernetes, workerImage: container.workerImage });
    } catch (error) {
      fail(`coding preflight failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    console.log(`coding preflight passed (${checks.join(", ")}) for ${container.workerImage}`);
    return;
  }

  if (operation === "preflight") {
    if (!isImmutableDockerImage(container.workerImage)) {
      fail("CODING_WORKER_IMAGE must use an immutable repository digest or local image ID.");
    }
    try {
      await execFile("docker", ["image", "inspect", container.workerImage], { maxBuffer: 1024 * 1024 });
    } catch {
      fail(`Docker cannot inspect coding worker image "${container.workerImage}".`);
    }
    console.log(`coding preflight passed for ${container.workerImage}`);
    return;
  }

  if (operation === "cleanup") {
    const { values } = parseArgs({ args: rest, options: { "run-id": { type: "string" } } });
    if (!values["run-id"]) fail("coding cleanup requires --run-id <id>.");
    const executor = buildConfiguredExecutor({ native: noopExecutor(), db: prisma });
    await executor.stop(values["run-id"], "operator cleanup");
    console.log(`coding cleanup requested for run ${values["run-id"]}`);
    return;
  }

  fail("coding requires preflight or cleanup --run-id <id>.");
}

async function listRuns(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      agent: { type: "string" },
      limit: { type: "string" },
      status: { type: "string" },
    },
  });

  const limit = values.limit ? Number(values.limit) : 20;
  if (!Number.isInteger(limit) || limit <= 0) {
    fail(`--limit must be a positive integer, got "${values.limit}".`);
  }

  if (values.status && !RUN_STATUSES.includes(values.status as RunStatus)) {
    fail(`--status must be one of ${RUN_STATUSES.join(", ")}, got "${values.status}".`);
  }

  let agentId: string | undefined;
  if (values.agent) {
    const agent = await prisma.agent.findUnique({ where: { name: values.agent } });
    if (!agent) {
      fail(`unknown agent "${values.agent}".`);
    }
    agentId = agent.id;
  }

  const runs = await prisma.run.findMany({
    where: {
      ...(agentId ? { agentId } : {}),
      ...(values.status ? { status: values.status as RunStatus } : {}),
    },
    include: { agent: true },
    orderBy: { startedAt: "desc" },
    take: limit,
  });

  if (runs.length === 0) {
    console.log("no runs found.");
    return;
  }

  for (const r of runs) {
    const finished = r.finishedAt ? r.finishedAt.toISOString() : "-";
    console.log(
      `${r.id}  ${r.agent.name.padEnd(20)}  ${r.trigger.padEnd(9)}  ${r.status.padEnd(9)}  ` +
        `${String(r.tokensIn).padStart(6)} in / ${String(r.tokensOut).padStart(6)} out  ` +
        `$${Number(r.costUsd).toFixed(6)}  started ${r.startedAt.toISOString()}  finished ${finished}`,
    );
  }
}

async function scheduler(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { scope: { type: "string" } } });
  const scope = values.scope ?? "default";
  // Parsed before anything starts, so a malformed CODING_MAX_CONCURRENT or
  // CODING_QUEUE_TIMEOUT_SEC fails fast.
  const concurrency = loadCodingConcurrencyConfig();

  const config = loadProviderConfig();
  const llm = buildLlmProvider();
  const engine = buildEngine();
  const secrets = buildSecrets();
  const datastore = buildDatastore(secrets);
  const memory = buildMemory();
  const nativeExecutor = buildExecutor(config, { llm, engine, datastore, secrets, memory }, prisma);
  const executor = buildConfiguredExecutor({ native: nativeExecutor, db: prisma, providerConfig: config });
  await executor.launch?.();
  const reconciler = startReconciler({ db: prisma, executor });
  const sched = startScheduler({
    executor,
    db: prisma,
    scope,
    onLeaderTick: async () => {
      await drainCodingQueue({ db: prisma, executor, ...concurrency });
    },
  });

  console.log(`wardby scheduler started (scope "${scope}"). Press Ctrl+C to stop.`);

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      console.log("\nwardby scheduler shutting down...");
      sched.stop();
      reconciler.stop();
      void Promise.resolve(executor.close?.())
        .catch((err: unknown) => cliLog.warn({ err }, "executor close failed during scheduler shutdown"))
        .finally(resolve);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

async function mcp(): Promise<void> {
  const handle = await startMcp();
  // startMcp() resolves once the transport is up (bound/listening), not
  // when it stops — block here the same way `scheduler` does, so main()'s
  // `finally { prisma.$disconnect() }` doesn't tear the connection down
  // out from under a server that's still supposed to be running.
  //
  // stderr, not stdout: in stdio mode stdout IS the JSON-RPC protocol
  // stream (unlike `scheduler`, which owns no such stream), so a stray
  // console.log here would corrupt every stdio-connected client.
  console.error("wardby mcp started. Press Ctrl+C to stop.");
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      console.error("\nwardby mcp shutting down...");
      void Promise.resolve(handle.close())
        .catch((err: unknown) => cliLog.warn({ err }, "mcp handle close failed during shutdown"))
        .finally(resolve);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

async function serve(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { scope: { type: "string" } } });
  const handle = await startServe({ scope: values.scope });
  // stderr, like `mcp`: stdout must stay clean in case a future transport
  // multiplexes it, and this keeps the two commands' output consistent.
  console.error(`wardby serve started (scope "${values.scope ?? "default"}"). Press Ctrl+C to stop.`);
  await new Promise<void>((resolve) => {
    const shutdown = () => {
      console.error("\nwardby serve shutting down...");
      void handle
        .close()
        .catch((err: unknown) => cliLog.warn({ err }, "serve close failed during shutdown"))
        .finally(resolve);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

async function importCommand(rest: string[]): Promise<void> {
  const opts = parseImportArgs(rest);
  const { report, result } = await runImport({ ...opts, db: prisma, env: process.env });
  console.log(report);
  if (result) {
    for (const w of result.webhookSecrets) console.log(`webhook secret (${w.agentName}): ${w.secret}`);
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

  try {
    if (command === "auth") {
      await authCommand(rest, prisma, process.env.AUTH_CREDENTIAL_HASH_KEY ?? "");
    } else if (command === "agent" && rest[0] === "create") {
      await agentCreate(rest.slice(1));
    } else if (command === "agent" && rest[0] === "list") {
      await agentList();
    } else if (command === "agent" && rest[0] === "schedule") {
      await agentSchedule(rest.slice(1));
    } else if (command === "tool" && rest[0] === "create") {
      await toolCreate(rest.slice(1));
    } else if (command === "tool" && rest[0] === "attach") {
      await toolAttach(rest.slice(1), false);
    } else if (command === "tool" && rest[0] === "detach") {
      await toolAttach(rest.slice(1), true);
    } else if (command === "tool" && rest[0] === "list") {
      await toolList(rest.slice(1));
    } else if (command === "run") {
      await run(rest[0]);
    } else if (command === "runs") {
      await listRuns(rest);
    } else if (command === "coding") {
      await codingOps(rest);
    } else if (command === "scheduler") {
      await scheduler(rest);
    } else if (command === "mcp") {
      await mcp();
    } else if (command === "serve") {
      await serve(rest);
    } else if (command === "import") {
      await importCommand(rest);
    } else {
      fail(
        "usage:\n" +
          '  wardby agent create --name <n> --model <m> --prompt <p> --budget <usd> [--schedule "<cron>"] [--timezone <tz>] [--max-turns <n>]\n' +
          "  wardby agent list\n" +
          '  wardby agent schedule <name> --cron "<expr>" [--timezone <tz>] [--disable]\n' +
          "  wardby tool create --name <n> --description <d> --params <file> --code <file>\n" +
          "  wardby tool attach <tool-name> <agent-name>\n" +
          "  wardby tool detach <tool-name> <agent-name>\n" +
          "  wardby tool list [--agent <name>]\n" +
          "  wardby run <name>\n" +
          "  wardby runs [--agent <name>] [--limit N] [--status <s>]\n" +
          "  wardby coding preflight   (JOB_LAUNCHER=docker or kubernetes)\n" +
          "  wardby coding cleanup --run-id <id>\n" +
          "  wardby scheduler [--scope default]\n" +
          "  wardby mcp   (MCP_TRANSPORT=stdio|http selects the transport)\n" +
          "  wardby serve [--scope default]   (mcp + scheduler + reconciler in one process; http only)\n" +
          "  wardby import <bundle-dir> --owner <subject> [--public] [--include-secrets --transfer-key <pem>] [--default-budget <usd>] [--dry-run] [--prefix <p>] [--on-conflict fail|skip|rename] [--allow-open-fetch]",
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
