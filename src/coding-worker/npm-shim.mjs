#!/usr/bin/env node
// Wardby's package-manager shim, installed in the coding worker's images as
// /opt/wardby/bin/npm-shim.mjs and linked as `npm`, `pnpm` and `yarn`, ahead
// of the real tools on the agent's PATH. It acts as the tool it is invoked as.
//
// For an install in a project with a lockfile (npm: `ci`, `install`/`i`/`add`
// and their aliases with package-lock.json or npm-shrinkwrap.json; pnpm:
// `install`/`i`/`add` with pnpm-lock.yaml; yarn: a bare `yarn`, `install` or
// `add` with yarn.lock), it first sends the lockfile to the registry proxy's
// `POST /registry/npm/-/plan`, which verifies it against npm and approves
// exactly its name@version entries for the run, so the install that follows
// is served without a dependency-graph walk. It prints a one-line summary
// (and any refusals) to stderr, then runs the real tool with the original
// arguments. Anything else runs the tool directly.
//
// pnpm and yarn may not be installed: when the project pins one with
// `packageManager` (pnpm, or yarn 2 or later: the image's yarn is classic),
// or the tool is missing, the shim runs it through corepack, which downloads
// the pinned release through the registry proxy.
//
// yarn classic downloads from the URLs a yarn.lock records, never from its
// configured registry, and the worker reaches only the proxy: for the
// install, public registry URLs in a classic yarn.lock point at the proxy,
// and afterwards the file is put back (or, if yarn rewrote it, its proxy URLs
// are mapped back to the host the original used).
//
// Security does not depend on this file: the proxy verifies every lockfile
// claim itself, and a failed or skipped plan only means the install goes
// through the registry's usual checks. So every failure here is reported
// and then ignored. Dependency-free on purpose (it runs before anything is
// installed).
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, join, relative, resolve } from "node:path";

const NPM_INSTALL_COMMANDS = new Set([
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

/** Per tool: the install commands (`""`: no command at all), the lockfiles
 *  it reads (in preference order), whether the lockfile may sit at a
 *  workspace root above the project, the options naming the project
 *  directory, and the options whose value is the next argument (the ones a
 *  command line is likely to put before the command). */
const TOOLS = {
  npm: {
    installs: NPM_INSTALL_COMMANDS,
    lockfiles: ["npm-shrinkwrap.json", "package-lock.json"],
    workspaceRoot: false,
    directoryOptions: ["--prefix", "-C"],
    valueOptions: new Set([
      "--prefix",
      "-C",
      "--loglevel",
      "--registry",
      "--cache",
      "--userconfig",
      "-w",
      "--workspace",
    ]),
  },
  pnpm: {
    installs: new Set(["install", "i", "add"]),
    lockfiles: ["pnpm-lock.yaml"],
    workspaceRoot: true,
    directoryOptions: ["--dir", "-C"],
    valueOptions: new Set(["--dir", "-C", "--filter", "-F", "--loglevel", "--reporter", "--registry", "--store-dir"]),
  },
  yarn: {
    // Every command that installs from yarn.lock (yarn classic downloads
    // from the URLs it records, see routeClassicLockfile), also as
    // `yarn workspace <name> <command>`.
    installs: new Set(["", "install", "add", "remove", "upgrade", "upgrade-interactive", "up"]),
    lockfiles: ["yarn.lock"],
    workspaceRoot: true,
    directoryOptions: ["--cwd"],
    valueOptions: new Set([
      "--cwd",
      "--registry",
      "--cache-folder",
      "--modules-folder",
      "--network-timeout",
      "--mutex",
    ]),
  },
};
const PLAN_TIMEOUT_MS = 180_000;
const MAX_LISTED_REFUSALS = 20;
/** Set for the real tool and everything it runs, so a nested install (a
 *  lifecycle script's) does not plan again. */
const ACTIVE = "WARDBY_NPM_SHIM_ACTIVE";
/** The public registry hosts yarn classic writes into a yarn.lock. */
const YARN_HOSTS = ["https://registry.yarnpkg.com/", "https://registry.npmjs.org/"];

const say = (line) => process.stderr.write(`wardby: ${line}\n`);

function selfPath() {
  try {
    return realpathSync(process.argv[1]);
  } catch {
    return process.argv[1];
  }
}

/** Which tool this shim is acting as: the name it was invoked by. */
function toolName() {
  const name = basename(process.argv[1] ?? "");
  return name === "pnpm" || name === "yarn" ? name : "npm";
}

/** The first `name` on PATH that is not this shim. */
function onPath(name) {
  const self = selfPath();
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
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

/** The command: the first argument that is neither an option nor an
 *  option's value (`""` when there is none). */
function commandOf(args, tool) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (TOOLS[tool].valueOptions.has(arg)) index += 1;
    else if (!arg.startsWith("-")) {
      // `yarn workspace <name> <command> ...` runs <command> in that workspace.
      if (tool === "yarn" && arg === "workspace") return commandOf(args.slice(index + 2), tool) || "workspace";
      return arg;
    }
  }
  return "";
}

/** The project the tool works on: its directory option when given, else
 *  the nearest directory from the working directory up that has a
 *  package.json. */
function projectDirectory(args, tool) {
  for (const option of TOOLS[tool].directoryOptions) {
    const at = args.indexOf(option);
    if (at >= 0 && args[at + 1]) return resolve(args[at + 1]);
    const inline = args.find((arg) => arg.startsWith(`${option}=`));
    if (inline) return resolve(inline.slice(option.length + 1));
  }
  let directory = process.cwd();
  for (;;) {
    if (existsSync(join(directory, "package.json"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) return process.cwd();
    directory = parent;
  }
}

/** The lockfile the install reads: in the project, or (pnpm and yarn
 *  workspaces) the nearest one above it. */
function findLockfile(project, tool) {
  let directory = project;
  for (;;) {
    for (const name of TOOLS[tool].lockfiles) {
      const path = join(directory, name);
      if (existsSync(path)) return path;
    }
    const parent = dirname(directory);
    if (!TOOLS[tool].workspaceRoot || parent === directory) return undefined;
    directory = parent;
  }
}

/** The `packageManager` the project pins (`yarn@4.1.0+sha…`), if any: in
 *  its own package.json or, for a workspace package, the workspace root's.
 *  Searches from the project up, and stops at a root (a package.json with
 *  `workspaces`, a pnpm-workspace.yaml, or a .git folder). */
function pinnedManager(project) {
  let directory = project;
  for (;;) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    } catch {
      manifest = undefined;
    }
    if (typeof manifest?.packageManager === "string") return manifest.packageManager;
    const root =
      (manifest && manifest.workspaces !== undefined) ||
      existsSync(join(directory, "pnpm-workspace.yaml")) ||
      existsSync(join(directory, ".git"));
    const parent = dirname(directory);
    if (root || parent === directory) return undefined;
    directory = parent;
  }
}

/** How to run the real tool: the installed one, or corepack when the
 *  project pins a release the installed one is not (pnpm, yarn 2+) or the
 *  tool is not installed at all. */
function realCommand(tool, project) {
  const installed = onPath(tool);
  if (tool === "npm") return installed ? { file: installed, prefix: [] } : undefined;
  const pinned = pinnedManager(project);
  const pinsThis = Boolean(pinned?.startsWith(`${tool}@`)) && !(tool === "yarn" && pinned.startsWith("yarn@1."));
  const corepack = (pinsThis || !installed) && onPath("corepack");
  if (corepack) return { file: corepack, prefix: [tool] };
  return installed ? { file: installed, prefix: [] } : undefined;
}

/** The registry URL and its auth token, from the environment the driver
 *  sets (npm_config_registry) and the npmrc it writes. */
function registryAuth() {
  const registry = process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY;
  const userconfig = process.env.npm_config_userconfig ?? process.env.NPM_CONFIG_USERCONFIG;
  if (!registry || !userconfig) return undefined;
  const base = registry.endsWith("/") ? registry : `${registry}/`;
  // Send the lockfile and token only to the proxy's own registry route,
  // which the driver names in WARDBY_NPM_PLAN_REGISTRY.
  if (!process.env.WARDBY_NPM_PLAN_REGISTRY || base !== process.env.WARDBY_NPM_PLAN_REGISTRY) return undefined;
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

async function planLockfile(lockfile, auth) {
  const label = relative(process.cwd(), lockfile) || basename(lockfile);
  try {
    const response = await fetch(`${auth.base}-/plan`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${auth.token}`,
        "content-type": lockfile.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8",
      },
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

// --- yarn classic: lockfile URLs through the proxy for the install ---------

/** A classic yarn.lock's `  resolved "<url>"` lines. */
const RESOLVED = /^(\s+resolved\s+")([^"\\]*)(")/gm;

function decode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/** `<name>/-/<unscoped>-<version>.tgz` for a proxy download path (the
 *  proxy's own `-/tarball/<name>/<version>`, or already that standard
 *  path), or undefined for anything else. */
function publicPath(path) {
  const own = path.match(/^-\/tarball\/([^/]+)\/([^/]+)$/);
  if (!own) return /^[^/].*\/-\/[^/]+\.tgz$/.test(path) ? path : undefined;
  const name = decode(own[1]);
  const version = decode(own[2]);
  if (!name || !version || !/^[\w.+-]+$/.test(version) || !/^(?:@[^/@]+\/)?[^/@]+$/.test(name)) return undefined;
  return `${name}/-/${name.slice(name.indexOf("/") + 1)}-${version}.tgz`;
}

/** For a yarn classic install: points the lockfile's public registry URLs
 *  at the proxy, in place, and returns how to put it back afterwards.
 *  Undefined when there is nothing to rewrite (or it cannot be done). */
function routeClassicLockfile(lockfile, base) {
  let original;
  try {
    original = readFileSync(lockfile, "utf8");
  } catch {
    return undefined;
  }
  if (!/^# yarn lockfile v1\s*$/m.test(original.slice(0, 1024))) return undefined;
  const counts = new Map(YARN_HOSTS.map((host) => [host, 0]));
  /** Each original download path (`<name>/-/<file>.tgz`) and its host. */
  const hosts = new Map();
  const routed = original.replace(RESOLVED, (match, open, url, close) => {
    const host = YARN_HOSTS.find((candidate) => url.startsWith(candidate));
    if (!host) return match;
    counts.set(host, counts.get(host) + 1);
    hosts.set(url.slice(host.length).split("#")[0], host);
    return `${open}${base}${url.slice(host.length)}${close}`;
  });
  if (routed === original) return undefined;
  // For an entry the original didn't have: the host most of its URLs use
  // (yarn's own on a tie).
  const predominant = [...counts.entries()].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
  try {
    writeFileSync(lockfile, routed);
  } catch (error) {
    say(`could not point yarn.lock at the registry proxy (${error instanceof Error ? error.message : "error"})`);
    return undefined;
  }
  return () => {
    try {
      const after = readFileSync(lockfile, "utf8");
      if (after === routed) {
        writeFileSync(lockfile, original);
        return;
      }
      const restored = after.replace(RESOLVED, (match, open, url, close) => {
        if (!url.startsWith(base)) return match;
        const hash = url.indexOf("#");
        const path = hash < 0 ? url.slice(base.length) : url.slice(base.length, hash);
        const mapped = publicPath(path);
        if (!mapped) return match;
        const host = hosts.get(mapped) ?? predominant;
        return `${open}${host}${mapped}${hash < 0 ? "" : url.slice(hash)}${close}`;
      });
      if (restored !== after) writeFileSync(lockfile, restored);
    } catch (error) {
      say(`could not restore yarn.lock's registry URLs (${error instanceof Error ? error.message : "error"})`);
    }
  };
}

/** npm_config_* settings only one tool reads: npm warns about each one on
 *  every command, so the driver can't set them for the whole worker. They
 *  go under the worker's npm cache folder (npm_config_cache). */
function toolSettings(tool) {
  const cache = process.env.npm_config_cache ?? process.env.NPM_CONFIG_CACHE;
  if (tool === "pnpm")
    return cache
      ? { npm_config_store_dir: join(cache, "pnpm-store"), npm_config_cache_dir: join(cache, "pnpm-cache") }
      : {};
  if (tool === "yarn")
    return {
      // yarn classic sends the npmrc's token only with always-auth (or for
      // a scoped package). yarn Berry reads none of npm's settings.
      npm_config_always_auth: "true",
      ...(cache ? { npm_config_cache_folder: join(cache, "yarn-classic") } : {}),
    };
  return {};
}

async function main() {
  const args = process.argv.slice(2);
  const tool = toolName();
  const project = projectDirectory(args, tool);
  const real = realCommand(tool, project);
  if (!real) {
    say(`${tool} is not installed`);
    process.exit(127);
  }
  let restore;
  let child;
  // Installed before the lockfile is rewritten: a signal that lands before
  // the real tool starts must still put the public URLs back, then die of it.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.on(signal, () => {
      if (child) return void child.kill(signal);
      restore?.();
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  if (process.env[ACTIVE] !== "1" && TOOLS[tool].installs.has(commandOf(args, tool))) {
    const lockfile = findLockfile(project, tool);
    const auth = lockfile && registryAuth();
    if (lockfile && auth) {
      await planLockfile(lockfile, auth);
      if (tool === "yarn") restore = routeClassicLockfile(lockfile, auth.base);
    }
  }
  child = spawn(real.file, [...real.prefix, ...args], {
    stdio: "inherit",
    env: {
      ...process.env,
      [ACTIVE]: "1",
      ...toolSettings(tool),
    },
  });
  child.on("error", (error) => {
    restore?.();
    say(`could not run ${tool}: ${error.message}`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    restore?.();
    if (signal) {
      // Die of the same signal, as the real tool did.
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    } else process.exit(code ?? 1);
  });
}

await main();
