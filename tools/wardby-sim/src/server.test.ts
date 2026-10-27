import { afterEach, describe, expect, it } from "vitest";
import { json, jsonBody, record } from "./http.js";
import { Router } from "./router.js";
import { createSimServer, simRequest, type SimServer } from "./server.js";
import type { SimService } from "./service.js";
import type { StatePart } from "./state.js";

class Counter implements StatePart {
  value = 0;
  reset(): void {
    this.value = 0;
  }
}

/** A toy service: POST /count adds to a counter kept in simulator state. */
function counterService(): SimService {
  const router = new Router()
    .on("POST", "/count", (req, _params, ctx) => {
      const counter = ctx.state.part<Counter>("counter")!;
      counter.value += Number(record(jsonBody(req)).by ?? 1);
      ctx.principal("tester");
      return json({ value: counter.value });
    })
    .on("GET", "/count", (_req, _params, ctx) => json({ value: ctx.state.part<Counter>("counter")!.value }));
  return {
    name: "toy",
    prefix: "/toy",
    handle: (req, ctx) => router.handle(req, ctx),
    routes: () => router.routes(),
    init: (state) => {
      if (!state.part("counter")) state.register("counter", new Counter());
    },
    actions: {
      "toy.add": async (args, { state }) => {
        const counter = state.part<Counter>("counter")!;
        counter.value += Number(args.by ?? 1);
        return { value: counter.value };
      },
    },
  };
}

const SECRET = "ghs_simulatorTokenThatMustNeverBeRecorded0001";

async function call(sim: SimServer, method: string, path: string, body?: unknown, headers?: Record<string, string>) {
  const response = await sim.dispatch(simRequest(method, path, body, headers));
  return { status: response.status, body: response.body ? (JSON.parse(String(response.body)) as unknown) : undefined };
}

describe("wardby-sim server skeleton", () => {
  let sim: SimServer | undefined;
  afterEach(async () => {
    await sim?.close();
    sim = undefined;
  });

  it("isolates scenarios: reset clears service state, calls and faults", async () => {
    sim = createSimServer({ services: [counterService()] });
    await call(sim, "POST", "/toy/count", { by: 5 });
    await call(sim, "POST", "/__sim/faults", {
      service: "toy",
      method: "GET",
      path: "/count",
      mode: "sticky",
      response: { status: 503 },
    });
    expect(sim.state.calls.list()).toHaveLength(1);
    expect((await call(sim, "POST", "/__sim/reset")).status).toBe(204);
    expect(sim.state.calls.list()).toHaveLength(0);
    expect(sim.state.faults.list()).toHaveLength(0);
    expect((await call(sim, "GET", "/toy/count")).body).toEqual({ value: 0 });
  });

  it("records each service call with its scheme and principal, never the credential", async () => {
    sim = createSimServer({ services: [counterService()] });
    await call(sim, "POST", "/toy/count?x=1", { by: 2 }, { authorization: `Bearer ${SECRET}` });
    await call(sim, "GET", "/nowhere");
    const { body } = await call(sim, "GET", "/__sim/calls?service=toy");
    const calls = record(body).calls as Record<string, unknown>[];
    expect(calls).toEqual([
      expect.objectContaining({
        seq: 1,
        service: "toy",
        method: "POST",
        path: "/count",
        query: "x=1",
        status: 200,
        auth: "bearer",
        principal: "tester",
        body: { by: 2 },
      }),
    ]);
    expect(JSON.stringify(sim.state.calls.list())).not.toContain(SECRET);
    expect(sim.state.calls.list({ service: "unknown" })).toHaveLength(1);
    expect(sim.state.calls.list({ since: 1 })).toHaveLength(1);
  });

  it("fires a one-shot fault once and a sticky fault until cleared", async () => {
    sim = createSimServer({ services: [counterService()] });
    const once = await call(sim, "POST", "/__sim/faults", {
      service: "toy",
      method: "POST",
      path: "/count",
      mode: "once",
      response: { status: 500, body: { message: "boom" } },
    });
    expect(once.status).toBe(201);
    expect((await call(sim, "POST", "/toy/count")).status).toBe(500);
    expect((await call(sim, "POST", "/toy/count")).body).toEqual({ value: 1 });
    const faulted = sim.state.calls.list({ service: "toy" });
    expect(faulted[0].faultId).toBe(record(once.body).id);
    expect(faulted[1].faultId).toBeUndefined();

    const sticky = await call(sim, "POST", "/__sim/faults", {
      service: "toy",
      method: "*",
      path: "/count",
      mode: "sticky",
      after: 1,
      response: { status: 429, headers: { "retry-after": "1" } },
    });
    expect((await call(sim, "GET", "/toy/count")).status).toBe(200);
    expect((await call(sim, "GET", "/toy/count")).status).toBe(429);
    expect((await call(sim, "POST", "/toy/count")).status).toBe(429);
    expect((await call(sim, "DELETE", `/__sim/faults/${String(record(sticky.body).id)}`)).status).toBe(204);
    expect((await call(sim, "GET", "/toy/count")).body).toEqual({ value: 1 });
  });

  it("holds a call for a delay-only fault, then answers from the real route", async () => {
    sim = createSimServer({ services: [counterService()] });
    const added = await call(sim, "POST", "/__sim/faults", {
      service: "toy",
      method: "POST",
      path: "/count",
      mode: "once",
      delayMs: 150,
      passThrough: true,
    });
    expect(added.status).toBe(201);
    const started = Date.now();
    expect((await call(sim, "POST", "/toy/count")).body).toEqual({ value: 1 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(sim.state.calls.list({ service: "toy" })[0].faultId).toBe(record(added.body).id);
  });

  it("rejects a malformed fault", async () => {
    sim = createSimServer({ services: [counterService()] });
    expect((await call(sim, "POST", "/__sim/faults", { service: "toy", mode: "always" })).status).toBe(400);
  });

  it("runs scripted steps in order and stops at an unknown action", async () => {
    sim = createSimServer({ services: [counterService()] });
    const ok = await call(sim, "POST", "/__sim/script", {
      steps: [
        { action: "toy.add", by: 2 },
        { action: "toy.add", by: 3 },
      ],
    });
    expect(ok.body).toEqual({ results: [{ value: 2 }, { value: 5 }] });
    const bad = await call(sim, "POST", "/__sim/script", { steps: [{ action: "toy.add" }, { action: "nope" }] });
    expect(bad).toMatchObject({ status: 400, body: { error: "unknown_action", index: 1 } });
  });

  it("serves over a real socket", async () => {
    sim = createSimServer({ services: [counterService()] });
    const url = await sim.listen();
    const response = await fetch(`${url}/toy/count`, { method: "POST", body: JSON.stringify({ by: 4 }) });
    expect(await response.json()).toEqual({ value: 4 });
    expect((await fetch(`${url}/__sim/health`)).status).toBe(200);
  });
});
