/**
 * The worker contract over a child process's stdin/stdout, as newline-delimited
 * JSON. The control plane writes the WorkerInput as the first line, then
 * answers the worker's requests; the worker writes requests and reads answers.
 * Both directions are capped at MAX_MESSAGE_BYTES per line. stderr is the
 * worker's diagnostics only.
 *
 * Frames, worker → control:  { id, request }
 * Frames, control → worker:  { id, ok: true, result } | { id, ok: false, error: { code, message, causeCode? } }
 *                            | { id, event }  (llm.stream events)  | { id, end: true }
 */

import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { LlmStreamEvent } from "../providers/llm/types.js";
import type { NativeGateway, WorkerLauncher } from "./gateway.js";
import {
  GatewayError,
  MAX_MESSAGE_BYTES,
  ProtocolError,
  toGatewayError,
  type GatewayErrorCode,
  type GatewayRequest,
} from "./protocol.js";
import type { GatewayTransport } from "./worker.js";

/** Splits a byte stream into lines, refusing any line over the cap. */
export function readLines(stream: Readable, onLine: (line: string) => void, onError: (err: Error) => void): void {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) onLine(line);
    }
    if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) {
      buffer = "";
      onError(new ProtocolError("message_too_large"));
    }
  });
}

function writeLine(stream: Writable, frame: unknown): void {
  const line = JSON.stringify(frame);
  if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) throw new ProtocolError("message_too_large");
  stream.write(`${line}\n`);
}

/** An error as the worker sees it: exactly what the HTTP path carries (protocol.ts toGatewayError). */
const errorFrame = (err: unknown) => {
  const { code, message, causeCode } = toGatewayError(err);
  return { code, message, ...(causeCode ? { causeCode } : {}) };
};

type Pending =
  | { kind: "call"; resolve: (value: unknown) => void; reject: (err: Error) => void }
  | { kind: "stream"; push: (event: LlmStreamEvent) => void; end: () => void; fail: (err: Error) => void };

/** The worker's side: requests out on `output`, answers in on `input`. */
export function createStdioTransport(input: Readable, output: Writable): GatewayTransport {
  let nextId = 0;
  const pending = new Map<number, Pending>();
  const failAll = (err: Error) => {
    for (const entry of pending.values()) (entry.kind === "call" ? entry.reject : entry.fail)(err);
    pending.clear();
  };
  readLines(
    input,
    (line) => {
      let frame: {
        id: number;
        ok?: boolean;
        result?: unknown;
        error?: { code: string; message: string; causeCode?: string };
        event?: LlmStreamEvent;
        end?: boolean;
      };
      try {
        frame = JSON.parse(line) as typeof frame;
      } catch {
        failAll(new ProtocolError("message_not_json"));
        return;
      }
      const entry = pending.get(frame.id);
      if (!entry) return;
      const error = frame.error
        ? new GatewayError(
            frame.error.code as GatewayErrorCode,
            frame.error.message,
            typeof frame.error.causeCode === "string" ? frame.error.causeCode : undefined,
          )
        : undefined;
      if (entry.kind === "call") {
        pending.delete(frame.id);
        if (error) entry.reject(error);
        else entry.resolve(frame.result ?? null);
      } else if (frame.event) {
        entry.push(frame.event);
      } else {
        pending.delete(frame.id);
        if (error) entry.fail(error);
        else entry.end();
      }
    },
    failAll,
  );
  input.on("end", () => failAll(new GatewayError("internal", "The gateway connection closed.")));

  return {
    call(request: GatewayRequest) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { kind: "call", resolve, reject });
        writeLine(output, { id, request });
      });
    },
    async *stream(request: GatewayRequest): AsyncIterable<LlmStreamEvent> {
      const id = ++nextId;
      const queue: LlmStreamEvent[] = [];
      let done = false;
      let failure: Error | undefined;
      let wake: (() => void) | undefined;
      const notify = () => {
        wake?.();
        wake = undefined;
      };
      pending.set(id, {
        kind: "stream",
        push: (event) => {
          queue.push(event);
          notify();
        },
        end: () => {
          done = true;
          notify();
        },
        fail: (err) => {
          failure = err;
          notify();
        },
      });
      writeLine(output, { id, request });
      for (;;) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (failure) throw failure;
        if (done) return;
        await new Promise<void>((resolve) => (wake = resolve));
      }
    },
  };
}

/** Serves one worker's requests from `gateway`, answering on `output`. */
export function serveStdioWorker(input: Readable, output: Writable, gateway: NativeGateway): void {
  readLines(
    input,
    (line) => {
      let frame: { id: number; request: unknown };
      try {
        frame = JSON.parse(line) as typeof frame;
      } catch {
        return; // An unparseable line has no id to answer; the worker's own call times out with its process.
      }
      const { id, request } = frame;
      const method = (request as { method?: unknown } | null)?.method;
      if (method === "llm.stream") {
        void (async () => {
          try {
            for await (const event of gateway.stream(request)) writeLine(output, { id, event });
            writeLine(output, { id, end: true });
          } catch (err) {
            writeLine(output, { id, ok: false, error: errorFrame(err) });
          }
        })();
        return;
      }
      void gateway.call(request).then(
        (result) => writeLine(output, { id, ok: true, result: result ?? null }),
        (err: unknown) => writeLine(output, { id, ok: false, error: errorFrame(err) }),
      );
    },
    () => {
      // An oversized line from the worker: drop it; the worker is killed with its run.
    },
  );
}

export interface WorkerProcessSpec {
  command: string;
  args: string[];
  /** The worker's whole environment. Defaults to empty: it needs nothing from the server's. */
  env?: Record<string, string>;
  cwd?: string;
}

/** Launches the worker as a child process speaking this transport on its stdio. */
export function createProcessLauncher(spec: WorkerProcessSpec): WorkerLauncher {
  return {
    run(input, gateway, signal) {
      return new Promise((resolve) => {
        const child = spawn(spec.command, spec.args, {
          env: spec.env ?? {},
          cwd: spec.cwd,
          stdio: ["pipe", "pipe", "inherit"],
        });
        const kill = () => child.kill("SIGKILL");
        signal.addEventListener("abort", kill, { once: true });
        child.on("error", () => resolve({ exitCode: null }));
        child.on("exit", (code) => {
          signal.removeEventListener("abort", kill);
          resolve({ exitCode: code });
        });
        // A worker that exits mid-answer closes its stdin under a pending write: not an error here.
        child.stdin.on("error", () => {});
        serveStdioWorker(child.stdout, child.stdin, gateway);
        writeLine(child.stdin, input);
      });
    },
  };
}
