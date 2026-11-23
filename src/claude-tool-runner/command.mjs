import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { formatRefusals, recentRefusals, registryAccess } from "../coding-worker/registry-refusals.mjs";

export const MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_COMMAND_BYTES = 16 * 1024;
/**
 * run_command's per-command time limits when the launcher's setup carries none (a launcher from
 * before commandTimeouts): 60 s unless the model asks, at most 120 s.
 */
export const LEGACY_DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 120_000;
/**
 * Bounds on the setup's commandTimeouts (claude-tool-setup.ts): the launcher caps both at the run's
 * timeoutSec, at most MAX_CODING_TIMEOUT_SEC (src/coding/profile.ts; a test keeps them equal).
 */
export const MIN_COMMAND_TIMEOUT_MS = 1_000;
export const MAX_COMMAND_TIMEOUT_MS = 7_200_000;
/** After a timeout's SIGTERM, how long the command's process group has before SIGKILL. */
export const KILL_GRACE_MS = 2_000;
/** The launcher's setup for this run (src/providers/jobs/claude-tool-setup.ts). */
export const TOOL_SETUP_ENV = "WARDBY_TOOL_SETUP";
/** The npm shim (src/coding-worker/npm-shim.mjs), ahead of the real npm. */
export const SHIM_DIRECTORY = "/opt/wardby/bin";
/**
 * A toolchain run's client (#599): the `wardby-cmd` binary built into this image
 * (src/command-agent). `wardby-cmd run <address> <tokenFile> -- argv...` forwards one command to
 * the toolchain container's agent and exits with the remote exit code.
 */
export const COMMAND_AGENT = "/opt/wardby/bin/wardby-cmd";
/** Where the launcher puts the agent's binary and the run's token, in every container that mounts it. */
const COMMAND_AGENT_DIR = "/opt/wardby-cmd/";
/**
 * A toolchain run with a `docker` service (setup.toolchain.docker): the folder in the agent's
 * directory where storage-init put the docker CLI and its compose plugin, appended to the
 * toolchain's PATH for each command, and the variables the CLI needs. The same values as
 * kubernetes-isolation.ts TOOLCHAIN_DOCKER_ENV (a test keeps them equal). Never a secret.
 */
export const TOOLCHAIN_DOCKER_DIR = `${COMMAND_AGENT_DIR}docker`;
export const TOOLCHAIN_DOCKER_ENV = Object.freeze({
  DOCKER_HOST: "unix:///wardby/docker/docker.sock",
  DOCKER_CONFIG: TOOLCHAIN_DOCKER_DIR,
});
/** The client's own failures: exit 125 and a last stderr line `wardby-cmd: <one of these>`. */
const COMMAND_AGENT_EXIT = 125;
export const TOOLCHAIN_FAILURES = Object.freeze(
  new Set(["toolchain_unusable:agent", "toolchain_unusable:shell", "toolchain_setup_failed", "connection lost"]),
);
/** How much of a toolchain command's stderr is kept, apart from the capped output, to find that line. */
const STDERR_TAIL_BYTES = 256;

const RESERVED_NAMES = new Set(["HOME", "LANG", "PATH", "TMPDIR", TOOL_SETUP_ENV]);
/** Workspace-relative cache root: registry config files (parseToolSetup) and the
 *  agent's temporary files (TMPDIR, below) both live here, so both stay out of
 *  the collected workspace via the ".cache" entry in collect-exclude.ts. */
const CACHE_DIRNAME = ".cache";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/**
 * Setup bounds; claude-tool-setup.ts builds within exactly these. Entries cover the registry's
 * variables plus every service test variable a run can carry (16 services x 32). The whole setup
 * travels as one environment variable, which Linux caps at 128 KiB.
 */
export const MAX_ENV_ENTRIES = 1024;
export const MAX_ENV_VALUE_BYTES = 4096;
export const MAX_FILES = 8;
export const MAX_FILE_BYTES = 16 * 1024;
export const MAX_SETUP_BYTES = 96 * 1024;
const FILE_MODES = new Set([0o600, 0o644]);
const EMPTY_SETUP = Object.freeze({ env: Object.freeze({}), files: Object.freeze([]) });

function cacheRootFor(workspacePath) {
  return `${workspacePath}/${CACHE_DIRNAME}`;
}

/** Where a command's TMPDIR points: workspace disk, not the tiny `/tmp` tmpfs
 *  (docker-isolation.ts's scratchMb caps it at 64 MiB, too small for a real
 *  `pip install` or `npm install` to unpack and build in). */
function cacheTmpDirFor(workspacePath) {
  return `${cacheRootFor(workspacePath)}/tmp`;
}

export function toolEnvironment(workspacePath = "/workspace") {
  return {
    HOME: "/home/wardby",
    LANG: "C.UTF-8",
    PATH: `${SHIM_DIRECTORY}:/usr/local/bin:/usr/bin:/bin`,
    TMPDIR: cacheTmpDirFor(workspacePath),
  };
}

/**
 * The launcher's setup: registry settings and service test variables for every command, and the
 * registry's config files under the workspace's .cache. Trusted input, still checked: anything
 * unexpected stops the tool runner before it reports ready, rather than running half-configured.
 */
export function parseToolSetup(raw, workspacePath = "/workspace") {
  if (raw === undefined || raw === "") return EMPTY_SETUP;
  const invalid = () => new Error("tool_setup_invalid");
  if (Buffer.byteLength(raw) > MAX_SETUP_BYTES) throw invalid();
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (!value || typeof value !== "object" || value.schemaVersion !== 1) throw invalid();
  if (!value.env || typeof value.env !== "object" || Array.isArray(value.env)) throw invalid();
  const entries = Object.entries(value.env);
  if (entries.length > MAX_ENV_ENTRIES) throw invalid();
  const env = {};
  for (const [name, text] of entries) {
    if (!ENV_NAME.test(name) || RESERVED_NAMES.has(name)) throw invalid();
    if (typeof text !== "string" || text.includes("\0") || Buffer.byteLength(text) > MAX_ENV_VALUE_BYTES)
      throw invalid();
    env[name] = text;
  }
  // Set by the launcher only on a dependency-cache run (claude-tool-setup.ts); main.mjs then offers
  // the worker its one prepare call. An older tool runner ignores the key.
  if (value.dependencyCache !== undefined && typeof value.dependencyCache !== "boolean") throw invalid();
  // The workspace volume size (MiB) the dependency cache must stay inside; only with the flag.
  if (value.diskMb !== undefined) {
    if (value.dependencyCache !== true) throw invalid();
    if (!Number.isSafeInteger(value.diskMb) || value.diskMb < 64 || value.diskMb > 32_768) throw invalid();
  }
  // An adopted warm round (claude-tool-setup.ts): only with the dependency cache flag.
  if (value.workspaceReused !== undefined) {
    if (typeof value.workspaceReused !== "boolean") throw invalid();
    if (value.workspaceReused && value.dependencyCache !== true) throw invalid();
  }
  // The run's per-command time limits (claude-tool-setup.ts); absent from an older launcher.
  let commandTimeouts;
  if (value.commandTimeouts !== undefined) {
    const limits = value.commandTimeouts;
    if (!limits || typeof limits !== "object" || Array.isArray(limits)) throw invalid();
    const bounded = (ms) => Number.isSafeInteger(ms) && ms >= MIN_COMMAND_TIMEOUT_MS && ms <= MAX_COMMAND_TIMEOUT_MS;
    if (!bounded(limits.defaultMs) || !bounded(limits.maxMs) || limits.defaultMs > limits.maxMs) throw invalid();
    commandTimeouts = Object.freeze({ defaultMs: limits.defaultMs, maxMs: limits.maxMs });
  }
  // The run's toolchain (claude-tool-setup.ts, #599): every command goes to its command agent on the
  // run's loopback. Only a loopback address and a token file in the agent's own folder.
  let toolchain;
  if (value.toolchain !== undefined) {
    const given = value.toolchain;
    if (!given || typeof given !== "object" || Array.isArray(given)) throw invalid();
    if (Object.keys(given).some((key) => key !== "address" && key !== "tokenFile" && key !== "docker")) throw invalid();
    // Only with a docker service in the run (claude-tool-setup.ts); the flag is never false.
    if (given.docker !== undefined && given.docker !== true) throw invalid();
    const address = typeof given.address === "string" ? /^127\.0\.0\.1:([0-9]{1,5})$/.exec(given.address) : null;
    const port = address ? Number(address[1]) : 0;
    if (port < 1 || port > 65_535) throw invalid();
    const { tokenFile } = given;
    if (
      typeof tokenFile !== "string" ||
      !tokenFile.startsWith(COMMAND_AGENT_DIR) ||
      tokenFile.length === COMMAND_AGENT_DIR.length ||
      tokenFile.includes("\0") ||
      tokenFile.split("/").some((segment) => segment === "..")
    )
      throw invalid();
    toolchain = Object.freeze({ address: given.address, tokenFile, ...(given.docker ? { docker: true } : {}) });
  }
  if (!Array.isArray(value.files) || value.files.length > MAX_FILES) throw invalid();
  const cacheRoot = `${cacheRootFor(workspacePath)}/`;
  const files = value.files.map((file) => {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") throw invalid();
    if (!file.path.startsWith(cacheRoot) || file.path.split("/").includes("..")) throw invalid();
    if (!FILE_MODES.has(file.mode) || Buffer.byteLength(file.content) > MAX_FILE_BYTES) throw invalid();
    return { path: file.path, content: file.content, mode: file.mode };
  });
  return Object.freeze({
    env: Object.freeze(env),
    files: Object.freeze(files),
    ...(value.dependencyCache === true ? { dependencyCache: true } : {}),
    ...(value.diskMb !== undefined ? { diskMb: value.diskMb } : {}),
    ...(commandTimeouts ? { commandTimeouts } : {}),
    ...(value.workspaceReused === true ? { workspaceReused: true } : {}),
    ...(toolchain ? { toolchain } : {}),
  });
}

/** run_command's default and longest time limit for this setup (the legacy 60 s / 120 s without one). */
export function commandTimeoutLimits(setup = EMPTY_SETUP) {
  return setup.commandTimeouts ?? { defaultMs: LEGACY_DEFAULT_TIMEOUT_MS, maxMs: MAX_TIMEOUT_MS };
}

/** Exactly what a command's shell gets (runCommand); the dependency cache's npm runs with it too. */
export function commandEnvironment(setup = EMPTY_SETUP, workspacePath = "/workspace") {
  return { ...setup.env, ...toolEnvironment(workspacePath) };
}

/**
 * What a toolchain command gets (spec section 3, last wins): the setup's variables (service test
 * variables, registry settings), then Wardby's fixed values, with TOOLCHAIN_DOCKER_ENV on a run with a
 * docker service. Never PATH or LANG: the toolchain image keeps its own (the agent drops both), so
 * runCommand appends the docker folder to PATH in the forwarded shell instead. The agent adds these
 * on top of the container's environment.
 */
export function toolchainEnvironment(setup = EMPTY_SETUP, workspacePath = "/workspace") {
  return {
    ...setup.env,
    HOME: "/home/wardby",
    USER: "wardby",
    LOGNAME: "wardby",
    TMPDIR: cacheTmpDirFor(workspacePath),
    // The workspace belongs to another uid in some launchers; git refuses it without this.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: workspacePath,
    ...(setup.toolchain?.docker ? TOOLCHAIN_DOCKER_ENV : {}),
  };
}

/**
 * The argv forwarded to a toolchain for one command: `/bin/sh -c <command>`, or on a run with a docker
 * service a shell that first appends TOOLCHAIN_DOCKER_DIR to the image's own PATH and then execs
 * exactly that (the command stays one argument, never spliced into the script).
 */
export function toolchainArgv(command, setup = EMPTY_SETUP) {
  if (!setup.toolchain?.docker) return ["/bin/sh", "-c", command];
  return [
    "/bin/sh",
    "-c",
    `PATH="\${PATH:+\$PATH:}${TOOLCHAIN_DOCKER_DIR}"; export PATH; exec /bin/sh -c "\$1"`,
    "sh",
    command,
  ];
}

/** The client's fixed failure (e.g. `toolchain_setup_failed`) when a toolchain command exits 125 with it. */
function toolchainFailure(code, stderrTail) {
  if (code !== COMMAND_AGENT_EXIT) return undefined;
  const lines = stderrTail.toString("utf8").split("\n");
  const last = lines.at(-1) === "" ? lines.at(-2) : lines.at(-1);
  const reason = last?.startsWith("wardby-cmd: ") ? last.slice("wardby-cmd: ".length) : undefined;
  return reason !== undefined && TOOLCHAIN_FAILURES.has(reason) ? reason : undefined;
}

/** What runCommand does to the workspace before each command: the setup files and TMPDIR. */
export async function prepareCommandWorkspace(setup = EMPTY_SETUP, workspacePath = "/workspace") {
  await applySetupFiles(setup);
  await ensureTmpDir(workspacePath);
}

/**
 * Rewritten before every command: the workspace is seeded after the tool runner starts, and a
 * command may delete its own .cache. Best effort: a file that can't be written leaves the package
 * manager unauthenticated, which the registry reports on its own.
 */
async function applySetupFiles(setup) {
  for (const file of setup.files) {
    try {
      await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
      await rm(file.path, { force: true });
      await writeFile(file.path, file.content, { mode: file.mode, flag: "wx" });
    } catch {
      // See above.
    }
  }
}

/**
 * Rewritten before every command, like applySetupFiles above: a command may delete its own
 * .cache (including TMPDIR), and a package manager needs the directory to already exist.
 */
async function ensureTmpDir(workspacePath) {
  try {
    await mkdir(cacheTmpDirFor(workspacePath), { recursive: true, mode: 0o700 });
  } catch {
    // Best effort: a command that can't create its own TMPDIR fails loudly on its own.
  }
}

/** How far before a command's start a refusal still counts as its own (the proxy's clock may lag). */
const REFUSAL_CLOCK_SLACK_MS = 2_000;

/**
 * A failed command's output, plus a line for each package the registry refused
 * while it ran: pip and uv don't print why (npm does, so its lines repeat what
 * it said). Bounded by the lookup's own timeout; never throws.
 */
export async function withPackageRefusals(result, env, startedAt, lookup = recentRefusals) {
  if (result.code === 0) return result;
  const lines = formatRefusals(await lookup(registryAccess(env), new Date(startedAt - REFUSAL_CLOCK_SLACK_MS)));
  return lines.length > 0 ? { ...result, output: `${result.output}\n${lines.join("\n")}\n` } : result;
}

/**
 * Runs one command for the model. With a toolchain (#599) it is forwarded through the client as
 * `/bin/sh -c` (no login shell: the image's own environment stands); otherwise `/bin/sh -lc` here.
 * Either way: its own process group, the 64 KiB cap, the timeout (SIGTERM to the group, SIGKILL
 * after KILL_GRACE_MS, exit 124; killing the client kills the remote command), and the registry's
 * refusals on failure. `spawn` and `lookup` are for tests.
 */
export async function runCommand(
  command,
  timeoutMs,
  workspacePath = "/workspace",
  setup = EMPTY_SETUP,
  { spawn: spawnCommand = spawn, lookup = recentRefusals } = {},
) {
  if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) throw new Error("tool_command_too_large");
  const timeout = Math.max(MIN_COMMAND_TIMEOUT_MS, Math.min(commandTimeoutLimits(setup).maxMs, timeoutMs));
  await prepareCommandWorkspace(setup, workspacePath);
  const { toolchain } = setup;
  const env = toolchain ? toolchainEnvironment(setup, workspacePath) : commandEnvironment(setup, workspacePath);
  const [file, args] = toolchain
    ? [COMMAND_AGENT, ["run", toolchain.address, toolchain.tokenFile, "--", ...toolchainArgv(command, setup)]]
    : ["/bin/sh", ["-lc", command]];
  const startedAt = Date.now();
  const result = await new Promise((resolve) => {
    const child = spawnCommand(file, args, {
      cwd: workspacePath,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so a timeout reaches grandchildren that still hold the pipes.
      detached: true,
    });
    const chunks = [];
    let size = 0;
    let timedOut = false;
    let stderrTail = Buffer.alloc(0);
    const append = (chunk) => {
      if (size >= MAX_OUTPUT_BYTES) return;
      const bounded = Buffer.from(chunk).subarray(0, MAX_OUTPUT_BYTES - size);
      chunks.push(bounded);
      size += bounded.byteLength;
    };
    child.stdout.on("data", append);
    child.stderr.on("data", (chunk) => {
      append(chunk);
      if (toolchain) stderrTail = Buffer.concat([stderrTail, Buffer.from(chunk)]).subarray(-STDERR_TAIL_BYTES);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup(child.pid, "SIGTERM");
      setTimeout(() => signalGroup(child.pid, "SIGKILL"), KILL_GRACE_MS).unref();
    }, timeout);
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) return resolve({ code: 124, output: Buffer.concat(chunks).toString("utf8") });
      // The client's own failure is the run's signal: its fixed line alone, nothing else the agent sent.
      const failure = toolchain ? toolchainFailure(code, stderrTail) : undefined;
      if (failure) return resolve({ code: COMMAND_AGENT_EXIT, output: `wardby-cmd: ${failure}`, fixed: true });
      resolve({ code: code ?? 1, output: Buffer.concat(chunks).toString("utf8") });
    });
    child.once("error", () => {
      clearTimeout(timer);
      // A missing client: this image is too old for the run's toolchain.
      if (toolchain) resolve({ code: COMMAND_AGENT_EXIT, output: "wardby-cmd: toolchain_unusable:agent", fixed: true });
      else resolve({ code: 1, output: "tool execution failed" });
    });
  });
  if (result.fixed) return { code: result.code, output: result.output };
  return withPackageRefusals(result, env, startedAt, lookup);
}

function signalGroup(pid, signal) {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}
