/**
 * The native worker's PID 1 on Substrate (WARDBY_NATIVE_SUBSTRATE=1): a minimal supervisor that runs
 * the real worker (the same entry, with WARDBY_NATIVE_SUPERVISED=1) as its child and reports the
 * child's exit to the gateway. Substrate's actor state never shows a process exit (an actor whose
 * PID 1 exits stays RUNNING), so without this a crashed worker would look running until its deadline.
 *
 * When the child exits, the supervisor POSTs `{ code }` (the exit code; a signal is 128 + its
 * number) to the gateway's exit route, with the public placeholder as its bearer: the egress gateway
 * replaces it with the run's capability on the wire, as for the worker's own requests, so the
 * supervisor never holds the capability. It reports only for a run actor (`wr-<20 hex>-native`): the
 * golden actor makes no request at all, and a canary has no session to report to. It retries a
 * network failure or a 5xx a few times, then idles forever, never exiting (an exited PID 1 tells
 * Substrate nothing and would only end the actor's last process).
 *
 * Nothing of the child's output passes through here (the child writes its own redacted stderr), and
 * the supervisor's one line is the exit code and a fixed outcome word. Worker-safe: Node built-ins,
 * protocol.ts and the bridge constants only.
 */

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { join } from "node:path";
import { DEFAULT_METADATA_DIR, NATIVE_SUFFIX, RUN_TOKEN_PATTERN } from "../substrate-bridge/constants.js";
import {
  NATIVE_GATEWAY_EXIT_PATH,
  NATIVE_PLACEHOLDER_CAPABILITY,
  NATIVE_SUPERVISED_ENV,
  nativeGatewayRouteUrl,
} from "./protocol.js";

/** How many times the exit is posted before the supervisor gives up (and idles). */
export const EXIT_REPORT_ATTEMPTS = 4;
const EXIT_REPORT_RETRY_MS = 2_000;
const EXIT_REPORT_TIMEOUT_MS = 10_000;
/** The code reported when the child could not be started at all. */
export const SPAWN_FAILED_CODE = 127;

/** What a crash handler needs to know about the one supervision in this process. */
const supervision = { childGone: false, reportStarted: false };

const RUN_ACTOR = new RegExp(`^${RUN_TOKEN_PATTERN.source.slice(1, -1)}${NATIVE_SUFFIX}$`);

export type ExitReport = "reported" | "refused" | "unreported" | "skipped";

export interface SupervisorOptions {
  env: NodeJS.ProcessEnv;
  /** The worker's entry script (process.argv[1]). */
  entry: string;
  /** Default process.execPath. */
  execPath?: string;
  /** Default process.execArgv. */
  execArgv?: readonly string[];
  /** Default DEFAULT_METADATA_DIR (/run/ate/actor). */
  metadataDir?: string;
  spawn?: typeof nodeSpawn;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  /** The supervisor's one line (default: stderr). */
  write?: (line: string) => void;
  /** Signals forwarded to the child (default: process). */
  signals?: Pick<NodeJS.Process, "on">;
}

/** A child's exit as one code: its own, or 128 + the signal's number (unknown signal: 128 + 0). */
export function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (typeof code === "number") return code;
  if (signal) return 128 + (osConstants.signals[signal] ?? 0);
  return 1;
}

/** Whether `<dir>/name` names a run's actor now (not the golden actor, not a canary). */
async function isRunActor(metadataDir: string): Promise<boolean> {
  try {
    return RUN_ACTOR.test((await readFile(join(metadataDir, "name"), "utf8")).trim());
  } catch {
    return false;
  }
}

/** The gateway's exit route from NATIVE_GATEWAY_URL, or undefined when it is not an http URL. */
function exitUrl(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.NATIVE_GATEWAY_URL;
  try {
    if (raw && new URL(raw).protocol === "http:") return nativeGatewayRouteUrl(raw, NATIVE_GATEWAY_EXIT_PATH);
  } catch {
    // Not a URL: nothing to report to.
  }
  return undefined;
}

/**
 * Posts `{ code }` with the placeholder bearer: `reported` on a 2xx, `refused` on any other non-5xx
 * answer (no retry: the gateway said no), `unreported` once every attempt failed or got a 5xx. No
 * error's text and no answer's body is kept.
 */
export async function reportExit(
  url: string,
  code: number,
  options: Pick<SupervisorOptions, "fetch" | "sleep"> = {},
): Promise<Exclude<ExitReport, "skipped">> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; attempt <= EXIT_REPORT_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${NATIVE_PLACEHOLDER_CAPABILITY}` },
        body: JSON.stringify({ code }),
        signal: AbortSignal.timeout(EXIT_REPORT_TIMEOUT_MS),
      });
      await response.body?.cancel().catch(() => {});
      if (response.status >= 200 && response.status < 300) return "reported";
      if (response.status < 500) return "refused";
    } catch {
      // Retried below; the error's text is never kept.
    }
    if (attempt < EXIT_REPORT_ATTEMPTS) await sleep(EXIT_REPORT_RETRY_MS);
  }
  return "unreported";
}

/**
 * Starts the worker as a child and waits for it to exit; then reports the exit (for a run actor)
 * and resolves with the code and the outcome. The caller idles after (see main.ts).
 */
export async function superviseOnce(options: SupervisorOptions): Promise<{ code: number; report: ExitReport }> {
  const spawn = options.spawn ?? nodeSpawn;
  const signals = options.signals ?? process;
  const code = await new Promise<number>((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(options.execPath ?? process.execPath, [...(options.execArgv ?? process.execArgv), options.entry], {
        env: { ...options.env, [NATIVE_SUPERVISED_ENV]: "1" },
        stdio: "inherit",
      });
    } catch {
      resolve(SPAWN_FAILED_CODE);
      return;
    }
    let settled = false;
    const settle = (value: number) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    child.once("error", () => settle(SPAWN_FAILED_CODE));
    child.once("exit", (exitCode, signal) => {
      supervision.childGone = true;
      settle(exitCodeOf(exitCode, signal));
    });
    // PID 1 gets no default signal handling: pass a stop on to the worker.
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      signals.on(signal, () => {
        if (!settled) child.kill(signal);
      });
    }
  });
  supervision.childGone = true;
  const url = exitUrl(options.env);
  let report: ExitReport = "skipped";
  if (url && (await isRunActor(options.metadataDir ?? DEFAULT_METADATA_DIR))) {
    supervision.reportStarted = true;
    report = await reportExit(url, code, options);
  }
  (options.write ?? ((line: string) => void process.stderr.write(line)))(
    `native sandbox worker exited: code ${code}, exit ${report}\n`,
  );
  return { code, report };
}

/** PID 1 in substrate mode: supervise the worker once, then idle forever. Never resolves. */
export async function superviseSubstrateWorker(options: SupervisorOptions): Promise<never> {
  await superviseOnce(options);
  // Nothing else keeps the event loop alive once the child is gone.
  setInterval(() => {}, 2 ** 30);
  return new Promise<never>(() => {});
}

/**
 * An unexpected error in the supervisor itself (PID 1): never exits, which would end the actor
 * without a report. Writes one fixed line (no error text), reports exit code 1 when the worker is
 * already gone and no report was begun, then idles like after a normal report. Never resolves.
 */
export async function superviseCrashed(options: SupervisorOptions): Promise<never> {
  try {
    (options.write ?? ((line: string) => void process.stderr.write(line)))("native sandbox supervisor failed\n");
    const url = exitUrl(options.env);
    if (supervision.childGone && !supervision.reportStarted && url) {
      supervision.reportStarted = true;
      if (await isRunActor(options.metadataDir ?? DEFAULT_METADATA_DIR)) await reportExit(url, 1, options);
    }
  } catch {
    // Nothing more to do: idle.
  }
  setInterval(() => {}, 2 ** 30);
  return new Promise<never>(() => {});
}

/** Test seam: forgets the recorded supervision state. */
export function resetSupervisionForTest(state: { childGone?: boolean; reportStarted?: boolean } = {}): void {
  supervision.childGone = state.childGone ?? false;
  supervision.reportStarted = state.reportStarted ?? false;
}
