/**
 * The start script of a coding-run service on the Substrate launcher (docs/coding-services.md).
 * Substrate runs a service container with its command overridden, so wardby supplies the script
 * that starts the image's own process (the catalog's startCommand), exports the entry's serviceEnv,
 * probes the entry's readiness command, and reports progress in a state file.
 *
 * The script is built only from the validated catalog snapshot (ResolvedCodingService). It carries
 * serviceEnv values, which can be secrets, so it lives only in the Codex/Claude setup blob (served by
 * the coding proxy to the workspace actor alone) and in the holder's script volume until the gate:
 * never in an actor template, a log or an error. The state file holds the fixed SERVICE_STATE_LINE
 * tokens only, never a value. The script never restarts the service and never exits.
 *
 * Pure: it imports only the ResolvedCodingService and UnstartableService types.
 */
import type { ResolvedCodingService } from "../../../coding/services/catalog.js";
import type { UnstartableService } from "../types.js";

/** Where a service container sees its own script volume (start.sh, state). Never a catalog path. */
export const SERVICE_SCRIPT_DIR = "/run/wardby-svc";
/** Where the holder sees service i's script volume: `${SERVICES_ROOT}/<i>` (i in name order). */
export const SERVICES_ROOT = "/run/wardby-services";
/**
 * One start script's largest size, and all of a run's together (inside the Codex setup's 96 KiB), both
 * as JSON-encoded in the setup document (substrateServiceProblems).
 */
export const MAX_SERVICE_SCRIPT_BYTES = 16 * 1024;
export const MAX_SERVICE_SCRIPTS_BYTES = 64 * 1024;
/** How long a service may go without writing its first state after start.sh is written (start_failed). */
export const SERVICE_START_MARKER_MS = 30_000;

/** The fixed state-file tokens (one line), written by the start script only. */
export const SERVICE_STATE_LINE =
  /^state=(starting|probing|ready|failed|exited)(?: attempts=([0-9]{1,5}))?(?: reason=(probe_failed))?\n?$/;

/** POSIX sh single quoting: `'` + value with each `'` as `'\''` + `'`. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

const quoteArgs = (args: readonly string[]): string => args.map(shellQuote).join(" ");

/** The run's services in the order of their template containers and volume indexes: by name. */
export function servicesInOrder(services: readonly ResolvedCodingService[]): ResolvedCodingService[] {
  return [...services].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The service's start script (spec section 5.3), from the validated snapshot only. Throws
 * "substrate_service_start_command_missing" for an entry without startCommand.
 */
export function serviceStartScript(service: ResolvedCodingService, options: { stateDir?: string } = {}): string {
  const { startCommand, readiness, serviceEnv } = service;
  if (startCommand === undefined) throw new Error("substrate_service_start_command_missing");
  const exports = Object.entries(serviceEnv)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    // Names match SERVICE_ENV_NAME (validated), so they are written unquoted; values are always quoted.
    .map(([name, value]) => `export ${name}=${shellQuote(value)}`);
  return (
    [
      "#!/bin/sh",
      "# wardby service start script (generated; never logged).",
      `dir=${shellQuote(options.stateDir ?? SERVICE_SCRIPT_DIR)}`,
      `st() { printf '%s\\n' "$1" > "$dir/state.tmp" && mv -f "$dir/state.tmp" "$dir/state"; }`,
      "idle() { while :; do sleep 3600; done; }",
      "st 'state=starting'",
      ...exports,
      `${quoteArgs(startCommand)} &`,
      "pid=$!",
      `if command -v timeout >/dev/null 2>&1; then t="timeout ${readiness.timeoutSeconds}"; else t=""; fi`,
      "n=0",
      "while :; do",
      `  if ! kill -0 "$pid" 2>/dev/null; then st 'state=exited'; idle; fi`,
      `  if $t ${quoteArgs(readiness.command)} >/dev/null 2>&1; then st 'state=ready'; break; fi`,
      "  n=$((n + 1))",
      `  if [ "$n" -ge ${readiness.failureThreshold} ]; then st 'state=failed reason=probe_failed'; idle; fi`,
      `  st "state=probing attempts=$n"`,
      `  sleep ${readiness.periodSeconds}`,
      "done",
      `wait "$pid"`,
      "st 'state=exited'",
      "idle",
    ].join("\n") + "\n"
  );
}

/** Whether `path` is the script directory, under it, or a parent of it (by path segments). */
function overlapsScriptDir(path: string): boolean {
  const a = path.split("/").filter(Boolean);
  const b = SERVICE_SCRIPT_DIR.split("/").filter(Boolean);
  const n = Math.min(a.length, b.length);
  return a.slice(0, n).every((segment, i) => segment === b[i]);
}

/** Why a service cannot run on this launcher (refused at dispatch). */
export function substrateServiceProblems(services: readonly ResolvedCodingService[]): UnstartableService[] {
  const problems: UnstartableService[] = [];
  let total = 0;
  for (const service of servicesInOrder(services)) {
    if (service.startCommand === undefined) {
      problems.push({ name: service.name, reason: "start_command_missing" });
      continue;
    }
    if (overlapsScriptDir(service.dataPath)) {
      problems.push({ name: service.name, reason: "data_path_reserved" });
      continue;
    }
    // Measured as the script will sit in the setup JSON (codexWorkerSetup, the Claude setup document):
    // JSON.stringify escapes each `"`, `\` and newline to two bytes, so a quote- or backslash-heavy
    // value that fits raw could still push the setup past its 96 KiB bound at launch.
    const size = Buffer.byteLength(JSON.stringify(serviceStartScript(service)));
    if (size > MAX_SERVICE_SCRIPT_BYTES || total + size > MAX_SERVICE_SCRIPTS_BYTES) {
      problems.push({ name: service.name, reason: "setup_too_large" });
      continue;
    }
    total += size;
  }
  return problems;
}

/**
 * How long the holder's bridge waits for every service: SERVICE_START_MARKER_MS plus the sum of
 * failureThreshold x (periodSeconds + timeoutSeconds) seconds, at most `capMs`.
 */
export function servicesWaitMs(services: readonly ResolvedCodingService[], capMs: number): number {
  const probing = services.reduce(
    (sum, { readiness }) =>
      sum + readiness.failureThreshold * (readiness.periodSeconds + readiness.timeoutSeconds) * 1000,
    0,
  );
  return Math.min(SERVICE_START_MARKER_MS + probing, capMs);
}
