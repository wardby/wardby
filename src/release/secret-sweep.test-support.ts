/**
 * The release suite's secret sweep (CLAUDE.md "Secrets never leave their boundary"): a test plants
 * fake secret values where a real one would flow (an upstream credential, an installation token,
 * a registry token, an agent's secret), drives the code, and asserts none of them reached any
 * output it can see:
 *
 * - every shared-logger line written since the sweep started, at every level (the release config
 *   logs at trace and setup.test-support.ts captures each line);
 * - console.* calls and process.stdout/stderr writes;
 * - whatever the test hands to `record` (an error, a tool result, a PR or comment body, a
 *   response, a database row, a lockfile).
 *
 * A value counts as leaked when its exact text, its URL-encoded, JSON-escaped or base64 form, or a
 * long piece of its start or end (holdsValueFragment, 12+ characters) appears. The assertion names
 * the channel and the value's label, never the value, so a failing run prints no secret either.
 */
import { vi } from "vitest";
import { holdsValueFragment } from "../sandbox/secret-fragments.test-support.js";
import { capturedLogLines } from "./log-capture.test-support.js";
import { rng, type Rng } from "./seeded.test-support.js";

/** Shapes a real secret takes: token-shaped ones the central redactor knows, and plain ones it cannot. */
export type SecretShape = "github-token" | "api-key" | "password" | "opaque";

/** The shortest start or end of a value that counts as a leak. */
const MIN_FRAGMENT = 12;

export interface SecretSweep {
  /** Every planted or tracked value. */
  readonly values: readonly string[];
  /** A new fake secret value of `shape`, tracked under `label`. */
  plant(label: string, shape?: SecretShape): string;
  /** Tracks a value a fixture already uses (an existing fake's token, say) under `label`. */
  track(label: string, value: string): string;
  /** Adds an output to check: text, an Error (message, stack and cause chain) or any JSON value. */
  record(channel: string, output: unknown): void;
  /** Channels a value reached, as `channel: label` (never the value). */
  leaks(): string[];
  /** Fails the test when any value reached any output. */
  assertClean(): void;
  /** Stops capturing console and process writes (log lines are captured for the whole file). */
  dispose(): void;
}

function planted(r: Rng, shape: SecretShape): string {
  switch (shape) {
    case "github-token":
      return `ghs_${r.string(36)}`;
    case "api-key":
      return `sk-${r.string(40)}`;
    case "password":
      // Characters that need escaping in URLs, JSON, regular expressions and shells.
      return `${r.string(10)}:/?#&%"\\$.*+(${r.string(10)}`;
    case "opaque":
      return r.string(32);
  }
}

function errorText(err: Error, depth = 0): string {
  const parts = [err.name, err.message, err.stack ?? ""];
  const cause = (err as Error & { cause?: unknown }).cause;
  if (depth < 5 && cause !== undefined) parts.push(textOf(cause, depth + 1));
  for (const [key, value] of Object.entries(err)) {
    if (key !== "cause") parts.push(textOf(value, depth + 1));
  }
  return parts.join("\n");
}

function textOf(output: unknown, depth = 0): string {
  if (typeof output === "string") return output;
  if (output instanceof Error) return errorText(output, depth);
  if (output instanceof Uint8Array) return Buffer.from(output).toString("utf8");
  try {
    return JSON.stringify(output, (_key, value: unknown) =>
      value instanceof Error ? errorText(value, depth + 1) : typeof value === "bigint" ? String(value) : value,
    );
  } catch {
    return String(output);
  }
}

/** The forms of a value an output may carry it in. */
function formsOf(value: string): string[] {
  return [
    value,
    encodeURIComponent(value),
    encodeURI(value),
    JSON.stringify(value).slice(1, -1),
    Buffer.from(value).toString("base64"),
    Buffer.from(value).toString("base64url"),
  ];
}

export function secretSweep(seed: number): SecretSweep {
  const r = rng(seed);
  const tracked: { label: string; value: string }[] = [];
  const recorded: { channel: string; text: string }[] = [];
  const firstLogLine = capturedLogLines.length;
  const written: { channel: string; text: string }[] = [];

  const spies = [
    ...(["log", "info", "warn", "error", "debug", "trace"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        written.push({ channel: `console.${method}`, text: args.map((arg) => textOf(arg)).join(" ") });
      }),
    ),
    ...(["stdout", "stderr"] as const).map((stream) => {
      const original = process[stream].write.bind(process[stream]);
      return vi.spyOn(process[stream], "write").mockImplementation((chunk: unknown, ...rest: unknown[]) => {
        written.push({ channel: `process.${stream}`, text: textOf(chunk) });
        return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
      });
    }),
  ];

  const sweep: SecretSweep = {
    get values() {
      return tracked.map((t) => t.value);
    },
    plant(label, shape = "opaque") {
      return sweep.track(label, planted(r, shape));
    },
    track(label, value) {
      if (value.length < MIN_FRAGMENT) throw new Error(`secretSweep: "${label}" is too short to sweep for`);
      tracked.push({ label, value });
      return value;
    },
    record(channel, output) {
      recorded.push({ channel, text: textOf(output) });
    },
    leaks() {
      const outputs = [
        ...capturedLogLines.slice(firstLogLine).map((text) => ({ channel: "log", text })),
        ...written,
        ...recorded,
      ];
      const found = new Set<string>();
      for (const { channel, text } of outputs) {
        for (const { label, value } of tracked) {
          const leaked =
            formsOf(value).some((form) => text.includes(form)) || holdsValueFragment(text, [value], MIN_FRAGMENT);
          if (leaked) found.add(`${channel}: ${label}`);
        }
      }
      return [...found].sort();
    },
    assertClean() {
      const leaks = sweep.leaks();
      if (leaks.length > 0) throw new Error(`secret values reached outputs: ${leaks.join("; ")}`);
    },
    dispose() {
      for (const spy of spies) spy.mockRestore();
    },
  };
  return sweep;
}
