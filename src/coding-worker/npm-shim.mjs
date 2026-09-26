#!/usr/bin/env node
// Wardby's npm shim, installed in the coding worker's driver image as
// /opt/wardby/bin/npm, ahead of the real npm on the agent's PATH.
//
// For an install (`npm ci`, `npm install`/`i`/`add` and their aliases) in a
// project with a package-lock.json (or npm-shrinkwrap.json), it first sends
// the lockfile to the registry proxy's `POST /registry/npm/-/plan`, which
// verifies it against npm and approves exactly its name@version entries for
// the run, so the install that follows is served without a dependency-graph
// walk. It prints a one-line summary (and any refusals) to stderr, then runs
// the real npm with the original arguments. Anything else runs npm directly.
//
// Security does not depend on this file: the proxy verifies every lockfile
// claim itself, and a failed or skipped plan only means the install goes
// through the registry's usual checks. So every failure here is reported
// and then ignored. Dependency-free on purpose (it runs before anything is
// installed).
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";

const INSTALL_COMMANDS = new Set([
  // npm ci and its aliases
  "ci",
  "clean-install",
  "ic",
  "install-clean",
  "isntall-clean",
  // npm install and its aliases
  "install",
  "add",
  "i",
  "in",
  "ins",
  "inst",
  "insta",
  "instal",
  "isnt",
  "isnta",
  "isntal",
  "isntall",
]);
const LOCKFILES = ["npm-shrinkwrap.json", "package-lock.json"];
const PLAN_TIMEOUT_MS = 180_000;
const MAX_LISTED_REFUSALS = 20;
/** Set for the real npm and everything it runs, so a nested npm (a
 *  lifecycle script's) does not plan again. */
const ACTIVE = "WARDBY_NPM_SHIM_ACTIVE";

const say = (line) => process.stderr.write(`wardby: ${line}\n`);

/** The real npm: the first `npm` on PATH that is not this shim. */
function realNpm() {
  let self;
  try {
    self = realpathSync(process.argv[1]);
  } catch {
    self = process.argv[1];
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "npm");
    try {
      if (!statSync(candidate).isFile()) continue;
      if (realpathSync(candidate) === self) continue;
      return candidate;
    } catch {
      // not there
    }
  }
  return undefined;
}

/** Options whose value is the next argument (the ones a command line is
 *  likely to put before the command). */
const VALUE_OPTIONS = new Set([
  "--prefix",
  "-C",
  "--loglevel",
  "--registry",
  "--cache",
  "--userconfig",
  "-w",
  "--workspace",
]);

/** The npm command: the first argument that is neither an option nor an
 *  option's value. */
function commandOf(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (VALUE_OPTIONS.has(arg)) index += 1;
    else if (!arg.startsWith("-")) return arg;
  }
  return undefined;
}

/** The project npm installs into: `--prefix` when given, else the nearest
 *  directory from the working directory up that has a package.json. */
function projectDirectory(args) {
  const prefixAt = args.findIndex((arg) => arg === "--prefix" || arg === "-C");
  if (prefixAt >= 0 && args[prefixAt + 1]) return resolve(args[prefixAt + 1]);
  const inline = args.find((arg) => arg.startsWith("--prefix="));
  if (inline) return resolve(inline.slice("--prefix=".length));
  let directory = process.cwd();
  for (;;) {
    if (existsSync(join(directory, "package.json"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return process.cwd();
    directory = parent;
  }
}

/** The registry URL and its auth token, from the environment the driver
 *  sets (npm_config_registry) and the npmrc it writes. */
function registryAuth() {
  const registry = process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY;
  const userconfig = process.env.npm_config_userconfig ?? process.env.NPM_CONFIG_USERCONFIG;
  if (!registry || !userconfig) return undefined;
  const base = registry.endsWith("/") ? registry : `${registry}/`;
  const prefix = `${base.replace(/^https?:/, "")}:_authToken=`;
  let npmrc;
  try {
    npmrc = readFileSync(userconfig, "utf8");
  } catch {
    return undefined;
  }
  const line = npmrc.split(/\r?\n/).find((entry) => entry.trim().startsWith(prefix));
  const token = line?.trim().slice(prefix.length).trim();
  return token ? { base, token } : undefined;
}

async function planLockfile(args) {
  if (process.env[ACTIVE] === "1" || !INSTALL_COMMANDS.has(commandOf(args) ?? "")) return;
  const project = projectDirectory(args);
  const lockfile = LOCKFILES.map((name) => join(project, name)).find((path) => existsSync(path));
  if (!lockfile) return;
  const auth = registryAuth();
  if (!auth) return;
  const label = lockfile.slice(project.length + 1);
  try {
    const response = await fetch(`${auth.base}-/plan`, {
      method: "POST",
      headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
      body: readFileSync(lockfile),
      signal: AbortSignal.timeout(PLAN_TIMEOUT_MS),
    });
    const text = await response.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (!response.ok || !body || typeof body.approved !== "number" || !Array.isArray(body.refused)) {
      const detail = body && typeof body.error === "string" ? body.error : `HTTP ${response.status}`;
      say(`${label} was not verified (${detail}); installing with the registry's usual checks`);
      return;
    }
    say(`verified ${label}: ${body.approved} approved, ${body.refused.length} refused`);
    for (const refusal of body.refused.slice(0, MAX_LISTED_REFUSALS)) {
      say(`  refused ${refusal.name}@${refusal.version}: ${refusal.code} (${refusal.reason})`);
    }
    if (body.refused.length > MAX_LISTED_REFUSALS)
      say(`  ...and ${body.refused.length - MAX_LISTED_REFUSALS} more refused`);
  } catch (error) {
    say(
      `${label} was not verified (${error instanceof Error ? error.message : "error"}); installing with the registry's usual checks`,
    );
  }
}

async function main() {
  const args = process.argv.slice(2);
  const npm = realNpm();
  if (!npm) {
    say("npm is not installed");
    process.exit(127);
  }
  await planLockfile(args);
  const child = spawn(npm, args, { stdio: "inherit", env: { ...process.env, [ACTIVE]: "1" } });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    say(`could not run npm: ${error.message}`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      // Die of the same signal, as the real npm did.
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    } else process.exit(code ?? 1);
  });
}

await main();
