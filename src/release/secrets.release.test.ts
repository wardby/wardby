/**
 * Release invariant 6: a secret value never reaches an output. The sweep itself
 * (secret-sweep.test-support.ts) is what the other release files call around their own paths;
 * this file proves it cannot pass vacuously (it sees a planted value on every channel and in
 * every encoding it claims to), and sweeps the central paths every output crosses: the shared
 * logger's error serializer and the gateway's error boundary.
 */
import { afterEach, describe, expect, it } from "vitest";
import { logger } from "../core/logger.js";
import { causeCodeOf } from "../core/error-code.js";
import { serveGatewayRequest } from "../native-worker/gateway-server.js";
import { baseSeed } from "./seeded.test-support.js";
import { secretSweep, type SecretShape, type SecretSweep } from "./secret-sweep.test-support.js";

const SHAPES: SecretShape[] = ["github-token", "api-key", "password", "opaque"];

let sweep: SecretSweep | undefined;
afterEach(() => {
  sweep?.dispose();
  sweep = undefined;
});

/** Waits for pino's asynchronous destination to hand queued lines to the line filter. */
const flushLogs = () => new Promise((resolve) => setImmediate(resolve));

describe("the secret sweep sees a planted value on every channel it claims", () => {
  const channels: Array<[string, (value: string) => void | Promise<void>, string]> = [
    ["a trace-level log line", (v) => logger.trace({ detail: `x ${v} y` }, "detail"), "log"],
    ["a child logger's debug line", (v) => logger.child({ module: "m" }).debug(`v=${v}`), "log"],
    ["console.error", (v) => console.error("oops", v), "console.error"],
    ["process.stderr", (v) => void process.stderr.write(`raw ${v}\n`), "process.stderr"],
    ["a recorded error's cause", (v) => sweep!.record("error", new Error("outer", { cause: new Error(v) })), "error"],
    ["a recorded value, URL-encoded", (v) => sweep!.record("url", `https://h/?q=${encodeURIComponent(v)}`), "url"],
    ["a recorded value, base64", (v) => sweep!.record("b64", Buffer.from(v).toString("base64")), "b64"],
    ["a recorded value, JSON-escaped", (v) => sweep!.record("json", { nested: [{ v }] }), "json"],
    ["a long piece of the value's start", (v) => sweep!.record("prefix", `${v.slice(0, 14)}…`), "prefix"],
  ];

  for (const shape of SHAPES) {
    for (const [name, emit, channel] of channels) {
      it(`${shape}: ${name}`, async () => {
        sweep = secretSweep(baseSeed());
        const value = sweep.plant("planted", shape);
        expect(sweep.leaks()).toEqual([]);
        await emit(value);
        await flushLogs();
        expect(sweep.leaks()).toContain(`${channel}: planted`);
        expect(() => sweep!.assertClean()).toThrow(/planted/);
        // The failure names the channel and label only.
        let message = "";
        try {
          sweep.assertClean();
        } catch (err) {
          message = (err as Error).message;
        }
        expect(message.includes(value)).toBe(false);
      });
    }
  }

  it("is clean when the value is nowhere, and ignores lines logged before it started", async () => {
    const early = secretSweep(baseSeed());
    const value = early.plant("planted", "password");
    early.dispose();
    logger.info({ value }, "before the second sweep");
    await flushLogs();
    sweep = secretSweep(baseSeed());
    sweep.track("planted", value);
    logger.info("unrelated");
    sweep.record("text", "nothing to see");
    await flushLogs();
    expect(sweep.leaks()).toEqual([]);
  });
});

describe("central output paths keep planted values out", () => {
  it("the shared logger's err serializer redacts token-shaped values anywhere in an error's cause chain", async () => {
    for (const shape of ["github-token", "api-key"] as const) {
      sweep = secretSweep(baseSeed());
      const value = sweep.plant(shape, shape);
      const inner = new Error(`git push https://x-access-token:${value}@github.com/o/r failed`);
      const err = new Error("push failed", { cause: new Error(`wrapped: ${value}`, { cause: inner }) });
      Object.assign(err, { stdout: `token=${value}` });
      logger.error({ err }, "push failed");
      await flushLogs();
      sweep.assertClean();
      sweep.dispose();
    }
  });

  it("a gateway error never carries the run's capability across the boundary, in the response or the log", async () => {
    for (const shape of SHAPES) {
      for (const message of [
        (cap: string) => `coding_execution_not_configured: ${cap}`,
        (cap: string) => `${cap}: something broke`,
        (cap: string) => `connect ECONNREFUSED while using ${cap}`,
      ]) {
        sweep = secretSweep(baseSeed());
        const capability = sweep.plant("capability", shape);
        const err = new Error(message(capability));
        const deps = {
          db: { nativeGatewaySession: { findUnique: async () => Promise.reject(err) } },
          providers: {},
        } as unknown as Parameters<typeof serveGatewayRequest>[0];
        const response = await serveGatewayRequest(deps, `Bearer ${capability}`, {});
        sweep.record("gateway response", response);
        await flushLogs();
        sweep.assertClean();
        sweep.dispose();
      }
    }
  });

  it("only a code-shaped word leaves as a cause code, never a bare token", () => {
    sweep = secretSweep(baseSeed());
    for (const shape of SHAPES) {
      const value = sweep.plant(shape, shape);
      sweep.record("cause code", causeCodeOf(new Error(`${value}: x`)) ?? "");
      sweep.record("cause code", causeCodeOf(`${value}`) ?? "");
    }
    sweep.assertClean();
  });
});
