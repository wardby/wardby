/**
 * The sandbox worker's stderr is not a redacted channel by itself: a failed worker's stderr tail
 * reaches the server's log (docker-launcher.ts), and a tool's host calls hand the worker secret
 * values (`secrets.get`). The worker knows those exact values, so it redacts them from everything
 * it writes to stderr — its own failure line and the shared logger's lines — with the same
 * redactor the console bridge uses (minimum length included). One set per worker process.
 */

import { setLogLineFilter } from "../core/logger.js";
import { redactExactSecretValues } from "../sandbox/host-functions.js";

const received = new Set<string>();

/** Records a secret value this process received, and its JSON-escaped form (as a log line holds it). */
export function rememberSecretValue(value: string): void {
  received.add(value);
  const escaped = JSON.stringify(value).slice(1, -1);
  if (escaped !== value) received.add(escaped);
}

/** `text` without any secret value this process received. */
export function redactReceivedSecrets(text: string): string {
  return received.size === 0 ? text : redactExactSecretValues(text, received);
}

let installed = false;

/** Routes process.stderr writes and the shared logger's lines through redactReceivedSecrets. */
export function installStderrRedaction(): void {
  if (installed) return;
  installed = true;
  setLogLineFilter(redactReceivedSecrets);
  const write = process.stderr.write.bind(process.stderr) as (...args: unknown[]) => boolean;
  process.stderr.write = (chunk: unknown, ...rest: unknown[]) => {
    const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : undefined;
    return text === undefined ? write(chunk, ...rest) : write(redactReceivedSecrets(text), ...rest);
  };
}
