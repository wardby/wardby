// TEST ONLY (wardby-sim). Helpers the kind runners share (Flow G, Flow J): waiting, the
// simulator's control API, process trees, the private database, and a minimal MCP stdio client.
import { execFileSync, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(2000);
  }
}

/** Runs scripted steps on the simulator at `sim` (its control API). */
export async function simScript(sim: string, steps: Record<string, unknown>[]): Promise<any[]> {
  const response = await fetch(`${sim}/__sim/script`, {
    method: "POST",
    body: JSON.stringify({ steps }),
    headers: { "content-type": "application/json" },
  });
  const body = (await response.json()) as { results: any[]; error?: string; message?: string };
  if (!response.ok) throw new Error(`sim script failed: ${body.error} ${body.message ?? ""}`);
  return body.results;
}

/** Ends a child and everything it started (its process group), or the child alone. */
export function killTree(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

export function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) out[match[1]] = match[2];
  }
  return out;
}

export function psql(sql: string, databaseUrl: string): string {
  const db = new URL(databaseUrl).pathname.slice(1);
  return execFileSync("docker", ["exec", "local-postgres-1", "psql", "-U", "wardby", "-d", db, "-At", "-c", sql], {
    encoding: "utf8",
  }).trim();
}

/** A minimal MCP stdio client: initialize, then tools/call. */
export class McpStdio {
  private next = 1;
  private readonly pending = new Map<number, (message: any) => void>();
  constructor(private readonly child: ChildProcess) {
    createInterface({ input: child.stdout! }).on("line", (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (typeof message.id === "number") this.pending.get(message.id)?.(message);
    });
  }
  request(method: string, params: unknown): Promise<any> {
    const id = this.next++;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out`)), 120_000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(`MCP ${method}: ${JSON.stringify(message.error)}`));
        else resolveRequest(message.result);
      });
      this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
  notify(method: string, params: unknown = {}): void {
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }
  async tool(name: string, args: Record<string, unknown>): Promise<any> {
    const result = await this.request("tools/call", { name, arguments: args });
    const text = (result.content ?? []).map((c: { text?: string }) => c.text ?? "").join("");
    if (result.isError) throw new Error(`${name} failed: ${text}`);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

export function portOpen(port: number): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection({ host: "127.0.0.1", port }, () => {
      socket.end();
      done(true);
    });
    socket.on("error", () => done(false));
  });
}
