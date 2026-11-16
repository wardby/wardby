/**
 * Coding-run services on the Substrate launcher, in the holder's bridge (the tool bridge of a pair,
 * the Codex bridge of a single actor). The launcher's setup carries each service's start script
 * (service-script.ts), in name order; service i's container waits for `start.sh` in its script
 * volume, which the holder sees at `<SERVICES_ROOT>/<i>`. The bridge writes each script there, then
 * reads each service's state file (the fixed SERVICE_STATE_LINE tokens) and posts every change to
 * the proxy (`POST services`) until all are ready, one fails, or the wait ends. Its bridge starts the
 * runner (pair) or fetches the input (single) only after that gate.
 *
 * A start script carries the entry's serviceEnv, which can be secret: it is never logged, and it is
 * removed from every script volume once the gate opens. A state file is read only as one of the fixed
 * tokens, and only the enum values parsed from it are posted or logged.
 *
 * Only Node built-ins and sibling files are imported: the image carries dist/substrate-bridge/ alone.
 */
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { postCapped, type Logger } from "./common.js";
import { MAX_SERVICE_SCRIPT_BYTES, MAX_SETUP_SERVICES, SERVICE_NAME, SERVICE_START_MARKER_MS } from "./constants.js";
import { abortableSleep, BridgeError, type RetryPolicy } from "./http.js";

export interface SetupService {
  name: string;
  script: string;
}

type ServiceState = "pending" | "probing" | "ready" | "failed";
type StateFailure = "probe_failed" | "exited";
export type UnreadyReason = "start_failed" | "probe_failed" | "exited" | "timed_out";

interface Report {
  name: string;
  state: ServiceState;
  attempts?: number;
  reason?: UnreadyReason;
}

const SETUP_SERVICE_KEYS = new Set(["name", "script"]);
const MAX_WAIT_MS = 3_600_000;
const DEFAULT_POLL_MS = 250;
/** How many times the final (failed) report is posted before the bridge idles without it. */
const FINAL_REPORT_ATTEMPTS = 5;
/** The state-file line (service-script.ts SERVICE_STATE_LINE), each state with exactly its own fields. */
const STATE_LINE = /^state=(?:(starting|ready|exited)|probing attempts=([0-9]{1,5})|failed reason=(probe_failed))\n?$/;

/** Absent → []; a valid list (≤ MAX_SETUP_SERVICES, names SERVICE_NAME, unique, scripts strings ≤ MAX_SERVICE_SCRIPT_BYTES, no other key) → it; else undefined. */
export function parseSetupServices(value: unknown): SetupService[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_SETUP_SERVICES) return undefined;
  const seen = new Set<string>();
  const services: SetupService[] = [];
  for (const entry of value as unknown[]) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const fields = entry as Record<string, unknown>;
    if (Object.keys(fields).some((key) => !SETUP_SERVICE_KEYS.has(key))) return undefined;
    const { name, script } = fields;
    if (typeof name !== "string" || !SERVICE_NAME.test(name) || seen.has(name)) return undefined;
    if (typeof script !== "string" || Buffer.byteLength(script) > MAX_SERVICE_SCRIPT_BYTES) return undefined;
    seen.add(name);
    services.push({ name, script });
  }
  return services;
}

/** A servicesWaitMs value: an integer 1..3_600_000, else undefined. */
export function parseServicesWaitMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_WAIT_MS ? value : undefined;
}

/** The state file's line (service-script.ts SERVICE_STATE_LINE), as a report; undefined for anything else. */
export function parseStateLine(
  text: string,
): { state: ServiceState; attempts?: number; reason?: StateFailure } | undefined {
  const match = STATE_LINE.exec(text);
  if (!match) return undefined;
  const [, plain, attempts, reason] = match;
  if (attempts !== undefined) return { state: "probing", attempts: Number(attempts) };
  if (reason !== undefined) return { state: "failed", reason: "probe_failed" };
  if (plain === "starting") return { state: "pending" };
  if (plain === "ready") return { state: "ready" };
  return { state: "failed", reason: "exited" };
}

/**
 * Why the gate did not open (a fixed code per service, never content). The bridge's readiness
 * server is still open until close(): the bridge idles with its probe answering, and the launcher
 * reads the report and removes the actor.
 */
export class ServicesUnreadyError extends BridgeError {
  constructor(
    readonly service: string,
    readonly reason: UnreadyReason,
    readonly close: () => Promise<void>,
  ) {
    super("substrate_bridge_service_unready");
  }
}

const sameReport = (a: Report, b: Report): boolean =>
  a.state === b.state && a.attempts === b.attempts && a.reason === b.reason;

/**
 * Writes each service's start.sh into `<root>/<i>/` (start.sh.tmp, mode 0644, then rename), then
 * polls each `<root>/<i>/state` every `pollMs` (default 250) and posts `services` (all of them,
 * through postCapped) on every change (a body is resent until delivered): until all are ready (resolves), one is failed or exited, one
 * wrote no state within SERVICE_START_MARKER_MS (start_failed), or `waitMs` passed (timed_out for
 * the first not-ready one); then posts once more, retrying that final report up to FINAL_REPORT_ATTEMPTS times. On success it deletes every start.sh and stops
 * reading. Logs only `substrate_bridge_services_written` { runToken, count },
 * `substrate_bridge_service_state` { runToken, service, state, attempts?, reason? } and
 * `substrate_bridge_services_ready` { runToken, ms }. Never logs a script or a state file's text.
 */
export async function startServices(o: {
  base: string;
  token: string;
  headers: Record<string, string>;
  root: string;
  services: readonly SetupService[];
  waitMs: number;
  pollMs?: number;
  policy: RetryPolicy;
  log: Logger;
  signal: AbortSignal;
  now?: () => number;
}): Promise<{ ok: true } | { ok: false; service: string; reason: UnreadyReason }> {
  const now = o.now ?? Date.now;
  const pollMs = o.pollMs ?? DEFAULT_POLL_MS;
  const folders = o.services.map((_, i) => join(o.root, String(i)));
  const reports: Report[] = o.services.map(({ name }) => ({ name, state: "pending" }));
  /** Whether service i has written any state yet (its start marker). */
  const marked = o.services.map(() => false);
  let lastPosted: string | undefined;

  /** Posts the reports unless this exact body was already delivered; true once it has been. */
  const post = async (): Promise<boolean> => {
    const body = { services: reports.map((report) => ({ ...report })) };
    const text = JSON.stringify(body);
    if (text === lastPosted) return true;
    const ok = await postCapped(`${o.base}/services`, o.headers, body, o.policy, o.log, "services", o.signal).catch(
      () => false,
    );
    if (ok) lastPosted = text;
    return ok;
  };
  const logState = (report: Report): void => {
    o.log("substrate_bridge_service_state", {
      runToken: o.token,
      service: report.name,
      state: report.state,
      ...(report.attempts !== undefined ? { attempts: report.attempts } : {}),
      ...(report.reason !== undefined ? { reason: report.reason } : {}),
    });
  };
  const fail = async (
    i: number,
    reason: UnreadyReason,
  ): Promise<{ ok: false; service: string; reason: UnreadyReason }> => {
    const report: Report = { name: reports[i].name, state: "failed", reason };
    if (!sameReport(report, reports[i])) {
      reports[i] = report;
      logState(report);
    }
    // The final report is what the launcher fails the run with: it is retried, never dropped silently.
    for (let n = 1; !(await post()) && n < FINAL_REPORT_ATTEMPTS && !o.signal.aborted; n++) {
      await abortableSleep(pollMs, o.signal).catch(() => undefined);
    }
    return { ok: false, service: report.name, reason };
  };

  const started = now();
  // 1. The scripts: each written whole (a temporary file, then a rename), so a service never runs half of one.
  for (const [i, { script }] of o.services.entries()) {
    try {
      await writeFile(join(folders[i], "start.sh.tmp"), script, { mode: 0o644 });
      await rename(join(folders[i], "start.sh.tmp"), join(folders[i], "start.sh"));
    } catch {
      return fail(i, "start_failed");
    }
  }
  o.log("substrate_bridge_services_written", { runToken: o.token, count: o.services.length });
  await post();

  // 2. The states, until the gate opens or one fails.
  for (;;) {
    if (o.signal.aborted) throw new BridgeError("substrate_bridge_stopped");
    let changed = false;
    for (const [i, folder] of folders.entries()) {
      const text = await readFile(join(folder, "state"), "utf8").catch(() => undefined);
      const parsed = text === undefined ? undefined : parseStateLine(text);
      if (!parsed) continue;
      marked[i] = true;
      const report: Report = { name: reports[i].name, ...parsed };
      if (sameReport(report, reports[i])) continue;
      reports[i] = report;
      logState(report);
      changed = true;
    }
    if (changed) await post();
    const failed = reports.findIndex((report) => report.state === "failed");
    if (failed !== -1) return fail(failed, reports[failed].reason ?? "probe_failed");
    if (reports.every((report) => report.state === "ready")) break;
    const elapsed = now() - started;
    const unmarked = marked.findIndex((mark) => !mark);
    if (unmarked !== -1 && elapsed >= SERVICE_START_MARKER_MS) return fail(unmarked, "start_failed");
    if (elapsed >= o.waitMs) {
      const waiting = reports
        .map((report, i) => ({ name: report.name, i }))
        .filter(({ i }) => reports[i].state !== "ready")
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return fail(waiting[0].i, "timed_out");
    }
    try {
      await abortableSleep(pollMs, o.signal);
    } catch {
      throw new BridgeError("substrate_bridge_stopped");
    }
  }

  // 3. Open: no script is left where anything else in the actor could read it.
  for (const folder of folders) await rm(join(folder, "start.sh"), { force: true });
  o.log("substrate_bridge_services_ready", { runToken: o.token, ms: now() - started });
  return { ok: true };
}
