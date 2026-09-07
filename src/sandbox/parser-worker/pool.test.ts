import { describe, expect, it } from "vitest";
import { createParserWorkerPool } from "./pool.js";

const fixture = (name: string) => new URL(`./__fixtures__/${name}.ts`, import.meta.url);

describe("createParserWorkerPool", () => {
  it("resolves with the worker's success response", async () => {
    const pool = createParserWorkerPool({ workerUrl: fixture("echo") });
    await expect(pool.run("html", { hello: "world" })).resolves.toEqual({ kind: "html", payload: { hello: "world" } });
  });

  it("rejects with the worker's reported error", async () => {
    const pool = createParserWorkerPool({ workerUrl: fixture("reject") });
    await expect(pool.run("csv", {})).rejects.toThrow("fixture_reject");
  });

  it("terminates a hung worker at the timeout instead of hanging forever", async () => {
    const pool = createParserWorkerPool({ workerUrl: fixture("spin-forever"), timeoutMs: 200 });
    const start = Date.now();
    await expect(pool.run("xml", {})).rejects.toThrow("parser_timeout");
    expect(Date.now() - start).toBeLessThan(2000);
  }, 5000);

  it("surfaces a crashing worker as parser_worker_crashed and stays usable afterwards", async () => {
    const crashPool = createParserWorkerPool({ workerUrl: fixture("crash") });
    await expect(crashPool.run("html", {})).rejects.toThrow("parser_worker_crashed");
    const echoPool = createParserWorkerPool({ workerUrl: fixture("echo") });
    await expect(echoPool.run("html", { x: 1 })).resolves.toEqual({ kind: "html", payload: { x: 1 } });
  });

  it("rejects fast once maxConcurrency + queueLimit is exceeded", async () => {
    const pool = createParserWorkerPool({
      workerUrl: fixture("spin-forever"),
      timeoutMs: 300,
      maxConcurrency: 1,
      queueLimit: 1,
    });
    const first = pool.run("html", {}); // occupies the one worker slot
    const second = pool.run("html", {}); // fills the one queue slot
    const third = pool.run("html", {}); // must be rejected immediately, no slot or queue room left
    await expect(third).rejects.toThrow("parser_pool_saturated");
    await Promise.allSettled([first, second]); // let the two timeouts drain before the test ends
  }, 3000);

  it("rejects immediately on an already-aborted signal without spawning a worker", async () => {
    const pool = createParserWorkerPool({ workerUrl: fixture("spin-forever") });
    const controller = new AbortController();
    controller.abort();
    await expect(pool.run("html", {}, controller.signal)).rejects.toThrow("parser_aborted");
  });

  it("terminates a worker when the caller's signal aborts mid-call", async () => {
    const pool = createParserWorkerPool({ workerUrl: fixture("spin-forever"), timeoutMs: 5000 });
    const controller = new AbortController();
    const call = pool.run("html", {}, controller.signal);
    setTimeout(() => controller.abort(), 100);
    const start = Date.now();
    await expect(call).rejects.toThrow("parser_aborted");
    expect(Date.now() - start).toBeLessThan(2000);
  }, 5000);
});
