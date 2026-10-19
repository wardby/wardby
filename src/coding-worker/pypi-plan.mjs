// Sends a Python lockfile (a uv.lock or a pinned requirements file) to the
// registry proxy's `POST /registry/pypi/-/plan`, which verifies it against PyPI
// and allows every package it pins that the agent's allowlist reaches, so an
// install from it isn't refused one transitive package at a time. Used by the
// uv shim (uv-shim.mjs) before an install and by `wardby-packages plan` (pip has
// no hook, and in the worker it only exists inside a venv, ahead of any shim).
//
// The token comes from PIP_INDEX_URL and is sent only as a Bearer header to the
// proxy's own registry route (registryAccess). A file planned once with the
// same bytes is not planned again in the run (each run has a limited number of
// plans): its sha256 is remembered under the worker's pip cache folder.
// Security does not depend on this file: the proxy verifies every claim, and
// a failed plan only means the install takes the registry's usual checks.
// Dependency-free on purpose, and never throws.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

const PLAN_TIMEOUT_MS = 180_000;
const MAX_LISTED_REFUSALS = 20;
const MAX_FIELD_CHARS = 400;
const PLANNED_FILE = ".wardby-planned";

const clean = (value) =>
  String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .slice(0, MAX_FIELD_CHARS);

function plannedPath(env) {
  return env.PIP_CACHE_DIR ? join(env.PIP_CACHE_DIR, PLANNED_FILE) : undefined;
}

function alreadyPlanned(env, digest) {
  const path = plannedPath(env);
  if (!path) return false;
  try {
    return readFileSync(path, "utf8").split("\n").includes(digest);
  } catch {
    return false;
  }
}

function remember(env, digest) {
  const path = plannedPath(env);
  if (!path) return;
  try {
    mkdirSync(env.PIP_CACHE_DIR, { recursive: true });
    appendFileSync(path, `${digest}\n`);
  } catch {
    // Only means the file may be planned again.
  }
}

/**
 * Plans `file` with the proxy. Returns the lines to print (each starting with
 * `wardby: `), or [] when it was already planned with these exact bytes.
 * `access` is registryAccess(env) (registry-refusals.mjs); undefined means no
 * registry is configured, and nothing is sent.
 */
export async function planPythonLockfile(file, access, env = process.env, fetchImpl = globalThis.fetch) {
  const label = relative(process.cwd(), file) || basename(file);
  if (!access) return [`wardby: ${clean(label)} was not verified: no package registry is configured for this run`];
  let body;
  try {
    body = readFileSync(file);
  } catch (error) {
    return [`wardby: ${clean(label)} was not verified: ${clean(error?.code ?? "unreadable")}`];
  }
  const digest = createHash("sha256").update(body).digest("hex");
  if (alreadyPlanned(env, digest)) return [];
  try {
    const response = await fetchImpl(`${access.base}pypi/-/plan`, {
      method: "POST",
      headers: { authorization: `Bearer ${access.token}`, "content-type": "text/plain; charset=utf-8" },
      body,
      signal: AbortSignal.timeout(PLAN_TIMEOUT_MS),
    });
    const text = await response.text();
    let result;
    try {
      result = JSON.parse(text);
    } catch {
      result = undefined;
    }
    if (!response.ok || !result || typeof result.approved !== "number" || !Array.isArray(result.refused)) {
      const detail = result && typeof result.error === "string" ? result.error : `HTTP ${response.status}`;
      return [
        `wardby: ${clean(label)} was not verified (${clean(detail)}); installing with the registry's usual checks`,
      ];
    }
    remember(env, digest);
    const lines = [`wardby: verified ${clean(label)}: ${result.approved} approved, ${result.refused.length} refused`];
    for (const refusal of result.refused.slice(0, MAX_LISTED_REFUSALS))
      lines.push(
        `wardby:   refused ${clean(refusal?.name)}@${clean(refusal?.version)}: ${clean(refusal?.code)} (${clean(refusal?.reason)})`,
      );
    if (result.refused.length > MAX_LISTED_REFUSALS)
      lines.push(`wardby:   ...and ${result.refused.length - MAX_LISTED_REFUSALS} more refused`);
    return lines;
  } catch (error) {
    return [
      `wardby: ${clean(label)} was not verified (${clean(error instanceof Error ? error.message : "error")}); installing with the registry's usual checks`,
    ];
  }
}
