import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import {
  composeProjectName,
  defaultModel,
  ensureWardbyIgnored,
  generatedSecret,
  providerKeyName,
  quickstartPaths,
  readQuickstartEnv,
  readQuickstartState,
  resolveProjectDir,
  writeQuickstartEnv,
  writeQuickstartState,
  type McpClient,
  type QuickstartPaths,
  type QuickstartProvider,
  type QuickstartState,
} from "./config.js";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const composeFile = join(packageRoot, "deploy/local/docker-compose.yml");
const schemaFile = join(packageRoot, "prisma/schema.prisma");
const wardbyBin = join(packageRoot, "bin/wardby.js");
const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version: string };
const require = createRequire(import.meta.url);
const DEMO_AGENT = "hello-wardby";
const DEMO_PROMPT =
  "You are the Wardby quickstart agent. Reply with a short greeting, then explain in one sentence that Wardby admitted this run against an explicit maximum budget. Do not call tools.";

interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; inherit?: boolean } = {},
): CommandResult {
  const spawnOptions: SpawnSyncOptionsWithStringEncoding = {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
  };
  const result = spawnSync(command, args, spawnOptions);
  if (result.error) {
    return { status: 1, stdout: result.stdout ?? "", stderr: result.error.message };
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function commandFailure(label: string, result: CommandResult): never {
  const detail = (result.stderr || result.stdout).trim();
  throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
}

function runtimeEnv(paths: QuickstartPaths, values = readQuickstartEnv(paths)): NodeJS.ProcessEnv {
  return { ...process.env, ...values, WARDBY_PROJECT_DIR: paths.projectDir };
}

function composeArgs(paths: QuickstartPaths, state: QuickstartState, args: string[]): string[] {
  return [
    "compose",
    "--project-name",
    state.composeProject,
    "--env-file",
    paths.envFile,
    "--file",
    composeFile,
    ...args,
  ];
}

function runCompose(
  paths: QuickstartPaths,
  state: QuickstartState,
  args: string[],
  options: { inherit?: boolean } = {},
): CommandResult {
  return runCommand("docker", composeArgs(paths, state, args), {
    cwd: paths.projectDir,
    env: runtimeEnv(paths),
    inherit: options.inherit,
  });
}

function nodeMajor(): number {
  return Number(process.versions.node.split(".")[0]);
}

function assertPrerequisites(): void {
  if (nodeMajor() < 24) throw new Error(`Node.js 24 or newer is required; found ${process.versions.node}.`);
  const docker = runCommand("docker", ["--version"]);
  if (docker.status !== 0) throw new Error("Docker is not installed or is not on PATH.");
  const compose = runCommand("docker", ["compose", "version"]);
  if (compose.status !== 0) throw new Error("Docker Compose v2 is required (`docker compose`).");
  const daemon = runCommand("docker", ["info"]);
  if (daemon.status !== 0) throw new Error("Docker is installed but its daemon is not available.");
}

async function portAvailable(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "0.0.0.0", port }, () => server.close(() => resolve(true)));
  });
}

async function selectPostgresPort(firstPort = 55432): Promise<number> {
  for (let port = firstPort; port <= 55532; port += 1) {
    if (await portAvailable(port)) return port;
  }
  throw new Error("No available local port was found between 55432 and 55532.");
}

async function startPostgres(
  paths: QuickstartPaths,
  state: QuickstartState,
  config: Record<string, string>,
): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const up = runCompose(paths, state, ["up", "--detach", "--wait", "--wait-timeout", "90"]);
    if (up.status === 0) return;

    const output = `${up.stderr}\n${up.stdout}`;
    if (!/port is already allocated|address already in use|bind for .* failed/i.test(output)) {
      commandFailure("PostgreSQL startup", up);
    }

    // Docker Desktop's port forwarder is not always visible to a host socket
    // probe. Clean up the failed container and converge on the next port.
    runCompose(paths, state, ["down"]);
    state.postgresPort = await selectPostgresPort(state.postgresPort + 1);
    config.WARDBY_POSTGRES_PORT = String(state.postgresPort);
    config.DATABASE_URL = databaseUrl(config, state.postgresPort);
    writeQuickstartEnv(paths, config);
    writeQuickstartState(paths, state);
    console.log(`! Port was occupied; retrying PostgreSQL on ${state.postgresPort}`);
  }
  throw new Error("PostgreSQL startup could not find a usable port after 10 attempts.");
}

function databaseUrl(config: Record<string, string>, port: number): string {
  const user = encodeURIComponent(config.WARDBY_POSTGRES_USER);
  const password = encodeURIComponent(config.WARDBY_POSTGRES_PASSWORD);
  const database = encodeURIComponent(config.WARDBY_POSTGRES_DB);
  return `postgresql://${user}:${password}@127.0.0.1:${port}/${database}`;
}

async function promptLine(question: string, fallback?: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await terminal.question(question)).trim();
    return answer || fallback || "";
  } finally {
    terminal.close();
  }
}

async function promptYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  const answer = (await promptLine(`${question}${suffix}`)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

async function promptSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    throw new Error("A provider key is required in the environment when stdin is not an interactive terminal.");
  }

  process.stdout.write(question);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") return finish(new Error("cancelled"));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else if (character >= " ") value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}

function parseProvider(value: string | undefined): QuickstartProvider | undefined {
  if (value === undefined) return undefined;
  if (value !== "openai" && value !== "anthropic") {
    throw new Error(`--provider must be openai or anthropic; got "${value}".`);
  }
  return value;
}

function parseClient(value: string | undefined): McpClient | undefined {
  if (value === undefined) return undefined;
  if (!(["none", "codex", "claude", "both"] as string[]).includes(value)) {
    throw new Error(`--client must be none, codex, claude, or both; got "${value}".`);
  }
  return value as McpClient;
}

async function chooseProvider(
  requested: QuickstartProvider | undefined,
  previous: QuickstartState | undefined,
  existing: Record<string, string>,
  nonInteractive: boolean,
): Promise<QuickstartProvider> {
  if (requested) return requested;
  if (previous) return previous.provider;
  if (existing.LLM_PROVIDER === "openai" || existing.LLM_PROVIDER === "anthropic") return existing.LLM_PROVIDER;
  if (process.env.OPENAI_API_KEY || existing.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY || existing.ANTHROPIC_API_KEY) return "anthropic";
  if (nonInteractive) throw new Error("--provider is required in non-interactive mode.");

  const answer = (await promptLine("Model provider: [1] OpenAI, [2] Anthropic [1] ", "1")).toLowerCase();
  if (answer === "1" || answer === "openai") return "openai";
  if (answer === "2" || answer === "anthropic") return "anthropic";
  throw new Error(`Unknown provider selection "${answer}".`);
}

function prismaCliPath(): string {
  return require.resolve("prisma/build/index.js");
}

function applyMigrations(paths: QuickstartPaths): void {
  const result = runCommand(process.execPath, [prismaCliPath(), "migrate", "deploy", "--schema", schemaFile], {
    cwd: paths.projectDir,
    env: runtimeEnv(paths),
  });
  if (result.status !== 0) commandFailure("Database migration", result);
}

async function seedDemo(paths: QuickstartPaths, state: QuickstartState, budget: number): Promise<void> {
  const { createPrismaClient } = await import("../core/db.js");
  const db = createPrismaClient(readQuickstartEnv(paths).DATABASE_URL);
  try {
    const existing = await db.agent.findUnique({ where: { name: DEMO_AGENT } });
    if (existing && existing.systemPrompt !== DEMO_PROMPT) {
      throw new Error(
        `An agent named "${DEMO_AGENT}" already exists and was not created by quickstart; rename it or use --skip-demo.`,
      );
    }
    if (existing) {
      await db.agent.update({
        where: { name: DEMO_AGENT },
        data: { model: state.model, budgetUsd: budget, maxTurns: 2 },
      });
    } else {
      await db.agent.create({
        data: {
          name: DEMO_AGENT,
          model: state.model,
          budgetUsd: budget,
          maxTurns: 2,
          systemPrompt: DEMO_PROMPT,
        },
      });
    }
  } finally {
    await db.$disconnect();
  }
}

function runDemo(paths: QuickstartPaths): void {
  const result = runCommand(process.execPath, [wardbyBin, "run", DEMO_AGENT], {
    cwd: paths.projectDir,
    env: runtimeEnv(paths),
    inherit: true,
  });
  if (result.status !== 0) throw new Error("The sample agent run failed; run `wardby doctor` for diagnostics.");
}

function clientInstalled(command: "codex" | "claude"): boolean {
  return runCommand(command, ["--version"]).status === 0;
}

function configureOneMcpClient(client: "codex" | "claude", paths: QuickstartPaths): void {
  if (!clientInstalled(client)) {
    console.warn(`! ${client} is not installed; skipped its MCP configuration.`);
    return;
  }

  const existing = runCommand(client, ["mcp", "get", "wardby"], { cwd: paths.projectDir });
  if (existing.status === 0) {
    console.log(`✓ ${client} already has an MCP server named wardby.`);
    return;
  }

  const packageSpec = `@wardby/cli@${packageJson.version}`;
  const args =
    client === "codex"
      ? [
          "mcp",
          "add",
          "--env",
          `WARDBY_PROJECT_DIR=${paths.projectDir}`,
          "wardby",
          "--",
          "npx",
          "--yes",
          packageSpec,
          "mcp",
        ]
      : [
          "mcp",
          "add",
          "--scope",
          "local",
          "-e",
          `WARDBY_PROJECT_DIR=${paths.projectDir}`,
          "wardby",
          "--",
          "npx",
          "--yes",
          packageSpec,
          "mcp",
        ];
  const result = runCommand(client, args, { cwd: paths.projectDir });
  if (result.status !== 0) commandFailure(`${client} MCP configuration`, result);
  console.log(`✓ Configured Wardby MCP for ${client}.`);
}

function configureMcpClients(client: McpClient, paths: QuickstartPaths): void {
  if (client === "codex" || client === "both") configureOneMcpClient("codex", paths);
  if (client === "claude" || client === "both") configureOneMcpClient("claude", paths);
}

async function chooseClient(nonInteractive: boolean): Promise<McpClient> {
  if (nonInteractive) return "none";
  const answer = (await promptLine("Configure MCP: [n]one, [c]odex, c[l]aude, [b]oth [n] ", "n")).toLowerCase();
  if (answer === "" || answer === "n" || answer === "none") return "none";
  if (answer === "c" || answer === "codex") return "codex";
  if (answer === "l" || answer === "claude") return "claude";
  if (answer === "b" || answer === "both") return "both";
  throw new Error(`Unknown MCP client selection "${answer}".`);
}

export async function quickstartCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      budget: { type: "string" },
      client: { type: "string" },
      "non-interactive": { type: "boolean" },
      "skip-demo": { type: "boolean" },
      yes: { type: "boolean", short: "y" },
    },
  });
  const nonInteractive = values["non-interactive"] ?? false;
  const skipDemo = values["skip-demo"] ?? false;
  const budget = values.budget === undefined ? 1 : Number(values.budget);
  if (!Number.isFinite(budget) || budget <= 0) throw new Error(`--budget must be positive; got "${values.budget}".`);
  if (nonInteractive && !skipDemo && !values.yes) {
    throw new Error("Non-interactive demo execution requires --yes because it may incur provider charges.");
  }

  console.log("Wardby quickstart\n");
  assertPrerequisites();
  console.log(`✓ Node.js ${process.versions.node}`);
  console.log("✓ Docker and Docker Compose are available");

  const projectDir = resolveProjectDir();
  const paths = quickstartPaths(projectDir);
  const previous = readQuickstartState(paths);
  const existing = readQuickstartEnv(paths);
  const provider = await chooseProvider(parseProvider(values.provider), previous, existing, nonInteractive);
  const model = values.model ?? (previous?.provider === provider ? previous.model : defaultModel(provider));
  const keyName = providerKeyName(provider);
  let providerKey = process.env[keyName] || existing[keyName];
  if (!providerKey && !skipDemo) {
    if (nonInteractive) throw new Error(`${keyName} is required in non-interactive mode unless --skip-demo is used.`);
    providerKey = await promptSecret(`${keyName}: `);
    if (!providerKey) throw new Error(`${keyName} cannot be empty.`);
  }

  const postgresPort = previous?.postgresPort ?? (await selectPostgresPort());
  const postgresUser = existing.WARDBY_POSTGRES_USER || "wardby";
  const postgresDatabase = existing.WARDBY_POSTGRES_DB || "wardby";
  const postgresPassword = existing.WARDBY_POSTGRES_PASSWORD || generatedSecret();
  const config: Record<string, string> = {
    ...existing,
    LLM_PROVIDER: provider,
    LOCAL_PRINCIPAL: existing.LOCAL_PRINCIPAL || "local",
    MCP_TRANSPORT: "stdio",
    SECRET_APP_KEY: existing.SECRET_APP_KEY || generatedSecret(),
    WARDBY_POSTGRES_DB: postgresDatabase,
    WARDBY_POSTGRES_PASSWORD: postgresPassword,
    WARDBY_POSTGRES_PORT: String(postgresPort),
    WARDBY_POSTGRES_USER: postgresUser,
  };
  config.DATABASE_URL = databaseUrl(config, postgresPort);
  if (providerKey) config[keyName] = providerKey;

  ensureWardbyIgnored(projectDir);
  writeQuickstartEnv(paths, config);
  const state: QuickstartState = {
    version: 1,
    projectDir,
    composeProject: previous?.composeProject ?? composeProjectName(projectDir),
    postgresPort,
    provider,
    model,
    packageVersion: packageJson.version,
    createdAt: previous?.createdAt ?? new Date().toISOString(),
  };
  writeQuickstartState(paths, state);
  console.log(`✓ Configuration ready in ${paths.wardbyDir}`);

  await startPostgres(paths, state, config);
  console.log(`✓ PostgreSQL is healthy on 127.0.0.1:${state.postgresPort}`);

  applyMigrations(paths);
  console.log("✓ Database migrations applied");

  if (!skipDemo) {
    await seedDemo(paths, state, budget);
    console.log(`✓ Sample agent "${DEMO_AGENT}" is ready`);
    const approved =
      values.yes || (await promptYesNo(`Run it now with a maximum budget of $${budget.toFixed(2)}?`, true));
    if (approved) runDemo(paths);
    else console.log(`Skipped the billed run. Start it later with: npx @wardby/cli@latest run ${DEMO_AGENT}`);
  }

  const client = parseClient(values.client) ?? (await chooseClient(nonInteractive));
  if (client !== "none") configureMcpClients(client, paths);

  console.log("\nWardby is ready.");
  console.log("  npx @wardby/cli@latest status");
  console.log("  npx @wardby/cli@latest doctor");
  console.log("  npx @wardby/cli@latest down");
}

async function databaseHealthy(paths: QuickstartPaths): Promise<boolean> {
  const env = readQuickstartEnv(paths);
  if (!env.DATABASE_URL) return false;
  const { createPrismaClient } = await import("../core/db.js");
  const db = createPrismaClient(env.DATABASE_URL);
  try {
    await db.$queryRawUnsafe("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await db.$disconnect();
  }
}

export async function doctorCommand(args: string[]): Promise<void> {
  parseArgs({ args, options: {} });
  const paths = quickstartPaths(resolveProjectDir());
  const checks: Array<[string, boolean, string?]> = [];
  checks.push(["Node.js 24 or newer", nodeMajor() >= 24, process.versions.node]);
  checks.push(["Docker CLI", runCommand("docker", ["--version"]).status === 0]);
  checks.push(["Docker Compose v2", runCommand("docker", ["compose", "version"]).status === 0]);
  checks.push(["Docker daemon", runCommand("docker", ["info"]).status === 0]);

  let state: QuickstartState | undefined;
  try {
    state = readQuickstartState(paths);
    checks.push(["Quickstart state", state !== undefined, paths.stateFile]);
  } catch (error) {
    checks.push(["Quickstart state", false, error instanceof Error ? error.message : String(error)]);
  }
  const env = readQuickstartEnv(paths);
  const key = state ? providerKeyName(state.provider) : undefined;
  checks.push(["Private configuration", Object.keys(env).length > 0, paths.envFile]);
  if (Object.keys(env).length > 0) {
    const mode = statSync(paths.envFile).mode & 0o777;
    checks.push(["Configuration permissions", (mode & 0o077) === 0, mode.toString(8)]);
    checks.push(["Secret encryption key", /^[a-f0-9]{64}$/i.test(env.SECRET_APP_KEY ?? "")]);
    if (key) checks.push([`${key} configured`, Boolean(env[key] || process.env[key])]);
  }
  if (state) {
    const ps = runCompose(paths, state, ["ps", "--status", "running", "--quiet"]);
    checks.push(["PostgreSQL container", ps.status === 0 && ps.stdout.trim().length > 0]);
    checks.push(["Database connection", await databaseHealthy(paths)]);
    const migrations = runCommand(process.execPath, [prismaCliPath(), "migrate", "status", "--schema", schemaFile], {
      cwd: paths.projectDir,
      env: runtimeEnv(paths),
    });
    checks.push(["Database migrations", migrations.status === 0]);
  }

  let failed = false;
  for (const [name, ok, detail] of checks) {
    failed ||= !ok;
    console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` (${detail})` : ""}`);
  }
  if (failed) process.exitCode = 1;
}

export async function statusCommand(args: string[]): Promise<void> {
  parseArgs({ args, options: {} });
  const paths = quickstartPaths(resolveProjectDir());
  const state = readQuickstartState(paths);
  if (!state) throw new Error(`Wardby is not initialized in ${paths.projectDir}; run \`wardby quickstart\`.`);
  console.log(`project: ${state.projectDir}`);
  console.log(`version: ${state.packageVersion}`);
  console.log(`provider/model: ${state.provider} / ${state.model}`);
  console.log(`postgres: 127.0.0.1:${state.postgresPort}`);
  const ps = runCompose(paths, state, ["ps"]);
  if (ps.status !== 0) commandFailure("Docker Compose status", ps);
  process.stdout.write(ps.stdout);
  const healthy = await databaseHealthy(paths);
  console.log(`database: ${healthy ? "healthy" : "unavailable"}`);
  if (!healthy) process.exitCode = 1;
}

export async function logsCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      follow: { type: "boolean", short: "f" },
      tail: { type: "string" },
    },
  });
  const paths = quickstartPaths(resolveProjectDir());
  const state = readQuickstartState(paths);
  if (!state) throw new Error(`Wardby is not initialized in ${paths.projectDir}; run \`wardby quickstart\`.`);
  const composeLogArgs = ["logs", "--tail", values.tail ?? "100"];
  if (values.follow) composeLogArgs.push("--follow");
  const result = runCompose(paths, state, composeLogArgs, { inherit: true });
  if (result.status !== 0) throw new Error("Docker Compose logs failed.");
}

export async function downCommand(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { volumes: { type: "boolean" } } });
  const paths = quickstartPaths(resolveProjectDir());
  const state = readQuickstartState(paths);
  if (!state) throw new Error(`Wardby is not initialized in ${paths.projectDir}; nothing to stop.`);
  const composeDownArgs = ["down"];
  if (values.volumes) composeDownArgs.push("--volumes");
  const result = runCompose(paths, state, composeDownArgs, { inherit: true });
  if (result.status !== 0) throw new Error("Docker Compose shutdown failed.");
  console.log(
    values.volumes ? "Wardby stopped and its local database volume was removed." : "Wardby stopped; data retained.",
  );
}
