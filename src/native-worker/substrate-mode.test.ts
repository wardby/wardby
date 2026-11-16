import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NATIVE_PLACEHOLDER_CAPABILITY, type WorkerInput } from "./protocol.js";
import { gatewayInputUrl, runSubstrateMode, type SubstrateModeOptions } from "./substrate-mode.js";

const GATEWAY_URL = "http://wardby-native-gateway.wardby.svc.cluster.local:8790/native-gateway/v1/call";
const INPUT_URL = "http://wardby-native-gateway.wardby.svc.cluster.local:8790/native-gateway/v1/input";
// Obviously fake: the real capability the egress gateway would inject. The worker must never see it.
const FAKE_NATIVE_CAP = "fake_native_capability_value_0042_never_in_worker";
const NATIVE_NAME = "wr-0123456789abcdef0123-native";

const INPUT = {
  v: 1,
  runId: "run-1",
  agent: { systemPrompt: "FAKE_SYSTEM_PROMPT_0042", model: "m", budgetUsd: 1, maxTurns: 4 },
  tools: [],
  builtinTools: [],
  userTools: {},
  runsConcurrently: [],
  pricing: {
    provider: "x",
    modelId: "m",
    encoding: "cl100k_base",
    inputPerMTok: 1,
    outputPerMTok: 2,
    cachedInputPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
    efforts: [],
    thinkingMode: "none",
  },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const served = () => json({ ok: true, result: { input: INPUT } });

/** A fake fetch that records each request and answers from `answers` in order (the last repeats). */
function recordingFetch(answers: Array<() => Response>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return answers[Math.min(calls.length - 1, answers.length - 1)]();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise((done) => server.close(done));
    }),
  );
});

function setup(over: Partial<SubstrateModeOptions> = {}) {
  const metadataDir = mkdtempSync(join(tmpdir(), "native-substrate-"));
  const recorded = recordingFetch([served]);
  const run = vi.fn(async (_input: WorkerInput) => {});
  const logged: unknown[] = [];
  const options: SubstrateModeOptions = {
    env: { NATIVE_GATEWAY_URL: GATEWAY_URL },
    metadataDir,
    readyPort: 0,
    fetch: recorded.fetch,
    sleep: async () => {},
    log: (event, fields) => void logged.push({ event, fields }),
    pollMs: 10,
    run,
    ...over,
  };
  const name = (value: string) => writeFileSync(join(metadataDir, "name"), `${value}\n`);
  return { options, recorded, run, name, logged };
}

/** A port nothing listens on right now. */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address() as AddressInfo;
  await new Promise((done) => probe.close(done));
  return port;
}

/** Starts substrate mode on a free /readyz port; resolves once /readyz answers. */
async function start(options: SubstrateModeOptions) {
  const port = await freePort();
  const done = runSubstrateMode({ ...options, readyPort: port });
  void done.then(
    ({ server }) => servers.push(server),
    () => {},
  );
  for (let i = 0; i < 100; i += 1) {
    if (await readyz(port).catch(() => 0)) break;
    await new Promise((wait) => setTimeout(wait, 10));
  }
  return { done, port };
}

const readyz = async (port: number) => (await fetch(`http://127.0.0.1:${port}/readyz`)).status;

describe("runSubstrateMode", () => {
  it("answers /readyz before it has a name, and makes no request", async () => {
    const { options, recorded, run, name } = setup();
    const { done, port } = await start(options);
    expect(await readyz(port)).toBe(200);
    await new Promise((wait) => setTimeout(wait, 300));
    expect(recorded.calls).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
    // Named at last, so the test leaves nothing waiting.
    name(NATIVE_NAME);
    await done;
  });

  it.each(["wardby-native-abc123", "wr-0123456789abcdef0123-tool", "wr-0123456789abcdef0123-native-x"])(
    "keeps waiting, with no request, while its name is %s (a golden or another role's name)",
    async (other) => {
      const { options, recorded, run, name } = setup();
      const { done, port } = await start(options);
      name(other);
      await new Promise((wait) => setTimeout(wait, 300));
      expect(await readyz(port)).toBe(200);
      expect(recorded.calls).toHaveLength(0);
      expect(run).not.toHaveBeenCalled();
      // Named as the run actor at last, so the test leaves nothing waiting.
      name(NATIVE_NAME);
      await done;
      expect(recorded.calls).toHaveLength(1);
    },
  );

  it("keeps a path prefix of NATIVE_GATEWAY_URL in the input URL", async () => {
    const prefixed = "http://gw.example:8790/team-a/native-gateway/v1/call";
    const { options, recorded, run, name } = setup({ env: { NATIVE_GATEWAY_URL: prefixed } });
    const { done } = await start(options);
    name(NATIVE_NAME);
    await done;
    expect(recorded.calls[0].url).toBe("http://gw.example:8790/team-a/native-gateway/v1/input");
    expect(run.mock.calls[0][0].gateway?.url).toBe(prefixed);
  });

  it.each([
    [GATEWAY_URL, INPUT_URL],
    ["http://gw.example/native-gateway/v1/call/", "http://gw.example/native-gateway/v1/input"],
    ["http://gw.example/a/b/native-gateway/v1/call?x=1#f", "http://gw.example/a/b/native-gateway/v1/input"],
    ["http://gw.example:8790", "http://gw.example:8790/native-gateway/v1/input"],
    ["http://gw.example/prefix/", "http://gw.example/prefix/native-gateway/v1/input"],
  ])("derives the input URL of %s", (call, input) => {
    expect(gatewayInputUrl(call)).toBe(input);
  });

  it("fetches its input once named, and runs it with the placeholder only", async () => {
    const { options, recorded, run, name, logged } = setup();
    const { done } = await start(options);
    name(NATIVE_NAME);
    await done;
    expect(recorded.calls).toHaveLength(1);
    expect(recorded.calls[0].url).toBe(INPUT_URL);
    expect(recorded.calls[0].init).toMatchObject({
      method: "POST",
      headers: { authorization: `Bearer ${NATIVE_PLACEHOLDER_CAPABILITY}` },
    });
    expect(run).toHaveBeenCalledTimes(1);
    const input = run.mock.calls[0][0];
    expect(input.gateway).toEqual({ url: GATEWAY_URL, capability: NATIVE_PLACEHOLDER_CAPABILITY });
    // The only capability-shaped value is the placeholder the worker added itself.
    const text = JSON.stringify(input);
    expect(text.split(NATIVE_PLACEHOLDER_CAPABILITY)).toHaveLength(2);
    expect(text).not.toContain(FAKE_NATIVE_CAP);
    // The input is never logged.
    expect(logged).toEqual([{ event: "substrate_bridge_waiting_for_identity", fields: undefined }]);
  });

  it("keeps /readyz answering after the run finishes", async () => {
    const { options, name } = setup();
    const { done, port } = await start(options);
    name(NATIVE_NAME);
    const { server } = await done;
    expect(server.listening).toBe(true);
    expect(await readyz(port)).toBe(200);
  });

  it("retries the input fetch", async () => {
    const recorded = recordingFetch([
      () => {
        throw new Error("connect ECONNREFUSED 10.0.0.1:8790");
      },
      () => json({ ok: false, error: { code: "not_ready", message: "not proven yet" } }, 503),
      served,
    ]);
    const { options, run, name } = setup({ fetch: recorded.fetch });
    const { done } = await start(options);
    name(NATIVE_NAME);
    await done;
    expect(recorded.calls).toHaveLength(3);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it.each([{}, { NATIVE_GATEWAY_URL: "not a url" }, { NATIVE_GATEWAY_URL: "https://gw.example:8790/x" }])(
    "fails with native_substrate_env_missing before the ready server starts (%o)",
    async (env) => {
      const port = await freePort();
      const { options } = setup({ env, readyPort: port });
      await expect(runSubstrateMode(options)).rejects.toThrow("native_substrate_env_missing");
      // The port was never bound: it is still free to take.
      const probe = createServer();
      await new Promise<void>((done, fail) => {
        probe.once("error", fail);
        probe.listen(port, done);
      });
      await new Promise((done) => probe.close(done));
    },
  );

  it.each<[string, () => Response, Record<string, unknown>]>([
    [
      "an answer that carries a gateway",
      () =>
        json({
          ok: true,
          result: { input: { ...INPUT, gateway: { url: GATEWAY_URL, capability: "x".repeat(40) } } },
        }),
      { message: "native_substrate_input_invalid" },
    ],
    [
      "an answer that is not an input",
      () => json({ ok: true, result: { input: { runId: FAKE_NATIVE_CAP } } }),
      { message: "native_substrate_input_invalid" },
    ],
    [
      "a 401",
      () => json({ ok: false, error: { code: "unauthorized", message: `Unknown capability ${FAKE_NATIVE_CAP}` } }, 401),
      { code: "unauthorized" },
    ],
    [
      "an internal error with a cause code",
      () =>
        json(
          {
            ok: false,
            error: { code: "internal", message: `boom ${FAKE_NATIVE_CAP}`, causeCode: FAKE_NATIVE_CAP },
          },
          500,
        ),
      { code: "internal" },
    ],
    [
      "an unknown error code",
      () => json({ ok: false, error: { code: FAKE_NATIVE_CAP, message: FAKE_NATIVE_CAP } }, 418),
      { code: "internal" },
    ],
  ])("fails with a fixed code on %s, never the gateway's text", async (_label, answer, expected) => {
    const recorded = recordingFetch([answer]);
    const { options, run, name } = setup({ fetch: recorded.fetch });
    const { done, port } = await start(options);
    name(NATIVE_NAME);
    const err = (await done.catch((e: unknown) => e)) as Error & { causeCode?: string };
    // Nothing is left listening after a failure.
    await expect(readyz(port)).rejects.toThrow();
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject(expected);
    expect(err.message).not.toContain(FAKE_NATIVE_CAP);
    expect(err.causeCode).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it("a canary name runs the canary hook", async () => {
    const canary = vi.fn(async (_url: string) => {});
    const { options, recorded, run, name } = setup({ canary });
    const { done } = await start(options);
    name("wr-0123456789abcdef0123-canary");
    await done;
    expect(canary).toHaveBeenCalledWith(GATEWAY_URL);
    expect(recorded.calls).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses a canary name until the canary exists", async () => {
    const { options, recorded, name } = setup();
    const { done } = await start(options);
    name("wr-0123456789abcdef0123-canary");
    await expect(done).rejects.toThrow("native_substrate_canary_unsupported");
    expect(recorded.calls).toHaveLength(0);
  });
});
