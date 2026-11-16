import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mcpWorkerEnv, waitForRunActor, waitForRunToken, withoutMcpEnv } from "./common.js";

describe("the worker's MCP env", () => {
  it("is header mode with the placeholder exactly when the input answer's flag is 1", () => {
    expect(mcpWorkerEnv({ "x-wardby-mcp-tools": "1" })).toStrictEqual({
      WARDBY_MCP_TOKEN: "rmt_placeholder_injected_by_gateway",
      WARDBY_MCP_TOKEN_HEADER: "x-wardby-mcp-token",
    });
  });

  it.each([
    ["no flag", {}],
    ["a flag of 0", { "x-wardby-mcp-tools": "0" }],
    ["a flag sent twice", { "x-wardby-mcp-tools": ["1"] }],
    ["a flag with spaces", { "x-wardby-mcp-tools": " 1" }],
    ["an empty flag", { "x-wardby-mcp-tools": "" }],
  ])("is empty with %s", (_label, headers) => {
    expect(mcpWorkerEnv(headers as Record<string, string>)).toStrictEqual({});
  });

  it("drops both MCP variables from an inherited env, and only those", () => {
    const env = { PATH: "/bin", WARDBY_MCP_TOKEN: "x", WARDBY_MCP_TOKEN_HEADER: "y" };
    expect(withoutMcpEnv(env)).toStrictEqual({ PATH: "/bin" });
    // The input is left as it was.
    expect(env).toStrictEqual({ PATH: "/bin", WARDBY_MCP_TOKEN: "x", WARDBY_MCP_TOKEN_HEADER: "y" });
    expect(withoutMcpEnv({ PATH: "/bin" })).toStrictEqual({ PATH: "/bin" });
  });
});

describe("waitForRunActor", () => {
  const POLL_MS = 10;
  const TOKEN = "wr-0123456789abcdef0123";
  const tempDir = () => mkdtempSync(join(tmpdir(), "actor-name-"));
  const name = (dir: string, value: string) => writeFileSync(join(dir, "name"), `${value}\n`);
  /** Resolves "pending" when `promise` has not settled after `polls` polls. */
  const stillWaiting = async (promise: Promise<unknown>, polls: number) =>
    Promise.race([
      promise.then(
        () => "settled",
        () => "settled",
      ),
      new Promise((done) => setTimeout(() => done("pending"), POLL_MS * polls + 20)),
    ]);

  it("waits through no name and the golden actor's name, then returns the native token and role", async () => {
    const dir = tempDir();
    const log = vi.fn();
    const waiting = waitForRunActor(dir, ["native"], { log, pollMs: POLL_MS });
    expect(await stillWaiting(waiting, 3)).toBe("pending");
    name(dir, "wardby-native-abc123");
    expect(await stillWaiting(waiting, 3)).toBe("pending");
    name(dir, `${TOKEN}-native`);
    expect(await waiting).toEqual({ token: TOKEN, role: "native" });
    expect(log.mock.calls).toEqual([["substrate_bridge_waiting_for_identity"]]);
  });

  it("returns the canary role for a canary name when canary is one of the roles", async () => {
    const dir = tempDir();
    name(dir, `${TOKEN}-canary`);
    expect(await waitForRunActor(dir, ["native", "canary"], { log: vi.fn(), pollMs: POLL_MS })).toEqual({
      token: TOKEN,
      role: "canary",
    });
  });

  it("keeps waiting on a coding name: a native worker never takes one", async () => {
    const dir = tempDir();
    name(dir, `${TOKEN}-tool`);
    const controller = new AbortController();
    const waiting = waitForRunActor(dir, ["native"], { log: vi.fn(), pollMs: POLL_MS, signal: controller.signal });
    expect(await stillWaiting(waiting, 3)).toBe("pending");
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ message: "substrate_bridge_stopped" });
  });

  it("stops with substrate_bridge_stopped when its signal aborts", async () => {
    const controller = new AbortController();
    const waiting = waitForRunActor(tempDir(), ["native"], { log: vi.fn(), pollMs: 60_000, signal: controller.signal });
    // Aborted while it sleeps between polls (the first read has come back by then).
    await new Promise((done) => setTimeout(done, 50));
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ message: "substrate_bridge_stopped" });
  });
});

describe("waitForRunToken on the shared poll loop", () => {
  const TOKEN = "wr-0123456789abcdef0123";
  const dirWith = (value: string) => {
    const dir = mkdtempSync(join(tmpdir(), "actor-name-"));
    writeFileSync(join(dir, "name"), value);
    return dir;
  };

  it("returns the token for its own role", async () => {
    expect(await waitForRunToken(dirWith(`${TOKEN}-agent`), "agent", { log: vi.fn(), pollMs: 10 })).toBe(TOKEN);
  });

  it("refuses the other coding role", async () => {
    await expect(
      waitForRunToken(dirWith(`${TOKEN}-tool`), "agent", { log: vi.fn(), pollMs: 10 }),
    ).rejects.toMatchObject({ message: "substrate_bridge_identity_invalid" });
  });

  it("keeps waiting on a native name", async () => {
    const controller = new AbortController();
    const waiting = waitForRunToken(dirWith(`${TOKEN}-native`), "tool", {
      log: vi.fn(),
      pollMs: 10,
      signal: controller.signal,
    });
    await new Promise((done) => setTimeout(done, 60));
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ message: "substrate_bridge_stopped" });
  });
});
