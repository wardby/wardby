#!/usr/bin/env node
// Wardby's uv shim, installed in the coding worker's images as
// /opt/wardby/bin/uv-shim.mjs and linked as `uv`, ahead of the real uv on the
// agent's PATH. It acts as uv.
//
// Before an install it verifies the lockfile with the registry proxy
// (pypi-plan.mjs), so uv can install every package it pins that the allowlist
// reaches: the project's uv.lock for `sync`, `run`, `add`, `remove`, `lock`,
// `export` and `tree`, and each requirements file of `uv pip install -r` and
// `uv pip sync`.
//
// uv installs a locked project from the file URLs its uv.lock records
// (files.pythonhosted.org), never from its configured index, and the worker
// reaches only the proxy. So for those project commands the lock's PyPI index
// and file URLs point at the proxy (without credentials: uv sends the index's),
// and afterwards the file is put back: as it was when uv left it alone, else
// with the proxy URLs mapped back to PyPI (a file the original named to its
// original URL, any other to PyPI's redirecting path). A uv.lock the command
// created is written with PyPI's URLs too.
//
// Security does not depend on this file: the proxy verifies every lockfile
// claim and every download itself. Every failure here is reported and then
// ignored. Dependency-free on purpose.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { planPythonLockfile } from "./pypi-plan.mjs";
import { registryAccess } from "./registry-refusals.mjs";
import { planTargets, proxyUrls, routeLock, unrouteLock } from "./uv-lock.mjs";

/** Set for the real uv and everything it runs, so a nested uv (inside `uv run`) changes nothing. */
const ACTIVE = "WARDBY_UV_SHIM_ACTIVE";
const say = (line) => process.stderr.write(`${line}\n`);

function selfPath() {
  try {
    return realpathSync(process.argv[1]);
  } catch {
    return process.argv[1];
  }
}

/** The first `uv` on PATH that is not this shim. */
function realUv() {
  const self = selfPath();
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "uv");
    try {
      if (!statSync(candidate).isFile() || realpathSync(candidate) === self) continue;
      return candidate;
    } catch {
      // not there
    }
  }
  return undefined;
}

function read(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function write(path, text, what) {
  try {
    writeFileSync(path, text);
  } catch (error) {
    say(`wardby: could not ${what} uv.lock (${error instanceof Error ? error.message : "error"})`);
  }
}

/** Routes the lock at `path` for the command; returns how to put it back (always defined). */
function routeForCommand(target, proxy) {
  if (typeof target !== "string") {
    // No lock yet: one the command creates is written with PyPI's URLs.
    const path = target.missing;
    return () => {
      const created = read(path);
      if (created !== undefined) {
        const restored = unrouteLock(created, proxy);
        if (restored !== created) write(path, restored, "restore");
      }
    };
  }
  const original = read(target);
  if (original === undefined) return () => {};
  const routed = routeLock(original, proxy);
  if (routed.text !== original) write(target, routed.text, "route");
  return () => {
    const after = read(target);
    if (after === undefined) return;
    if (after === routed.text) {
      if (after !== original) write(target, original, "restore");
      return;
    }
    const restored = unrouteLock(after, proxy, routed.originals);
    if (restored !== after) write(target, restored, "restore");
  };
}

async function main() {
  const args = process.argv.slice(2);
  const real = realUv();
  if (!real) {
    say("wardby: uv is not installed");
    process.exit(127);
  }
  let restore;
  let child;
  // Installed before the lock is rewritten: a signal that lands before uv
  // starts must still put the lock back, then die of it.
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.on(signal, () => {
      if (child) return void child.kill(signal);
      restore?.();
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    });
  const proxy = proxyUrls();
  if (process.env[ACTIVE] !== "1" && proxy) {
    const targets = planTargets(args);
    const access = registryAccess();
    const files = [...(targets.requirements ?? []), ...(typeof targets.lock === "string" ? [targets.lock] : [])];
    for (const file of files)
      if (existsSync(file)) for (const line of await planPythonLockfile(file, access)) say(line);
    if (targets.lock) restore = routeForCommand(targets.lock, proxy);
  }
  child = spawn(real, args, { stdio: "inherit", env: { ...process.env, [ACTIVE]: "1" } });
  child.on("error", (error) => {
    restore?.();
    say(`wardby: could not run uv: ${error.message}`);
    process.exit(127);
  });
  child.on("exit", (code, signal) => {
    restore?.();
    if (signal) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
    } else process.exit(code ?? 1);
  });
}

await main();
