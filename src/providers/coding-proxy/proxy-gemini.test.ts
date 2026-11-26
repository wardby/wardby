import { describe, expect, it, vi } from "vitest";
import { MemoryProxyLedger } from "./memory-ledger.js";
import { CodingProxy, capabilityHash } from "./proxy.js";
import { shippedCatalog } from "../llm/catalog.js";
import { entryOf } from "../llm/catalog-types.js";
import { VERTEX_CREDENTIAL_REF } from "./gemini-upstream.js";
import {
  body,
  FAKE_GEMINI_KEY,
  FAKE_VERTEX_TOKEN,
  gemini,
  okStream,
  sse,
  STUDIO,
  TestSink,
  usage,
  VERTEX_US,
} from "./gemini.test-support.js";
// Import only what the current task's tests use (lint refuses unused imports); later tasks extend this list.

describe("gemini-generate-content sessions", () => {
  it("creates an AI Studio and a Vertex session and stores the web-tool policy (default off)", async () => {
    const studio = await gemini();
    const vertex = await gemini({ model: VERTEX_US, webTools: "search" });
    const read = async (h: Awaited<ReturnType<typeof gemini>>) =>
      (await h.ledger.findSessionByCapabilityHash(capabilityHash(h.session.capability)))!;
    expect((await read(studio)).webTools).toBe("off");
    expect((await read(vertex)).webTools).toBe("search");
    expect((await read(vertex)).protocol).toBe("gemini-generate-content");
  });

  it("refuses a Gemini session without terms, with a non-Gemini entry, or with the wrong credential kind", async () => {
    const proxy = new CodingProxy({ ledger: new MemoryProxyLedger(), credentials: { resolve: async () => "x" } });
    const base = {
      runId: "r",
      protocol: "gemini-generate-content" as const,
      deadlineAt: new Date(Date.now() + 60_000),
      budgetUsd: 1,
    };
    const studio = entryOf(shippedCatalog().require(STUDIO));
    const vertex = entryOf(shippedCatalog().require(VERTEX_US));
    const sonnet = entryOf(shippedCatalog().require("claude-sonnet-5"));
    await expect(
      proxy.createSession({ ...base, credentialRef: "env:GEMINI_API_KEY", allowedModels: [STUDIO] }),
    ).rejects.toThrow("invalid_proxy_model_terms");
    await expect(
      proxy.createSession({
        ...base,
        credentialRef: "env:GEMINI_API_KEY",
        allowedModels: ["claude-sonnet-5"],
        terms: { version: "v", entry: sonnet },
      }),
    ).rejects.toThrow("invalid_proxy_model_terms");
    await expect(
      proxy.createSession({
        ...base,
        credentialRef: VERTEX_CREDENTIAL_REF,
        allowedModels: [STUDIO],
        terms: { version: "v", entry: studio },
      }),
    ).rejects.toThrow("invalid_proxy_credential_reference");
    await expect(
      proxy.createSession({
        ...base,
        credentialRef: "env:GEMINI_API_KEY",
        allowedModels: [VERTEX_US],
        terms: { version: "v", entry: vertex },
      }),
    ).rejects.toThrow("invalid_proxy_credential_reference");
  });

  it("refuses an unknown web-tool policy, and any policy but off on another protocol", async () => {
    const proxy = new CodingProxy({
      ledger: new MemoryProxyLedger(),
      credentials: { resolve: async () => "x" },
      pricing: () => ({ encoding: "o200k_base", inputPerMTok: 1, outputPerMTok: 1 }),
    });
    const entry = entryOf(shippedCatalog().require(STUDIO));
    await expect(
      proxy.createSession({
        runId: "a",
        credentialRef: "env:GEMINI_API_KEY",
        protocol: "gemini-generate-content",
        allowedModels: [STUDIO],
        deadlineAt: new Date(Date.now() + 60_000),
        budgetUsd: 1,
        terms: { version: "v", entry },
        webTools: "everything" as never,
      }),
    ).rejects.toThrow("invalid_proxy_web_tools");
    await expect(
      proxy.createSession({
        runId: "b",
        credentialRef: "openai/a",
        protocol: "openai-responses",
        allowedModels: ["test-model"],
        deadlineAt: new Date(Date.now() + 60_000),
        budgetUsd: 1,
        webTools: "search",
      }),
    ).rejects.toThrow("invalid_proxy_web_tools");
  });
});

const callOf = (h: Awaited<ReturnType<typeof gemini>>, index = 0) => {
  const [url, init] = h.fetch.mock.calls[index] as unknown as [string, RequestInit];
  return { url, headers: new Headers(init.headers), body: init.body as string };
};

describe("relaying Gemini calls", () => {
  it("sends AI Studio calls with the key in x-goog-api-key only, and settles the latest usage", async () => {
    const h = await gemini();
    const sink = await h.execute(body());
    const call = callOf(h);
    expect(call.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-neon:streamGenerateContent?alt=sse",
    );
    expect(call.headers.get("x-goog-api-key")).toBe(FAKE_GEMINI_KEY);
    expect(call.headers.get("authorization")).toBeNull();
    expect(call.url).not.toContain(FAKE_GEMINI_KEY);
    expect(JSON.parse(call.body)).toEqual(body());
    expect(sink.text()).toContain(" there");
    const id = h.events.find((e) => e.type === "request.reserved")!.requestId!;
    expect(await h.ledger.getRequest(id)).toMatchObject({
      status: "completed",
      usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 4, cacheWriteTokens: 0 },
    });
  });

  it("sends Vertex calls to the regional express-mode path rewritten to the project, with the proxy's bearer", async () => {
    const h = await gemini({ model: VERTEX_US });
    await h.execute(body());
    const call = callOf(h);
    expect(call.url).toBe(
      "https://aiplatform.us.rep.googleapis.com/v1beta1/projects/example-project/locations/us/publishers/google/models/gemini-4-neon:streamGenerateContent?alt=sse",
    );
    expect(call.headers.get("authorization")).toBe(`Bearer ${FAKE_VERTEX_TOKEN}`);
    expect(call.headers.get("x-goog-api-key")).toBeNull();
  });

  it("settles a non-stream generateContent reply from its usageMetadata", async () => {
    const h = await gemini({
      fetch: async () =>
        Response.json({
          candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          usageMetadata: usage(20, 3, 10),
        }),
    });
    const sink = await h.execute(body(), "generateContent");
    expect(callOf(h).url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-4-neon:generateContent");
    expect(JSON.parse(sink.text()).usageMetadata.promptTokenCount).toBe(20);
    const id = h.events.find((e) => e.type === "request.reserved")!.requestId!;
    expect((await h.ledger.getRequest(id))?.usage).toMatchObject({ inputTokens: 20, cachedInputTokens: 10 });
  });

  it("holds the last frame back until the reply is settled", async () => {
    const h = await gemini();
    const sink = new TestSink();
    const seen: (string | undefined)[] = [];
    sink.onWrite = async () => {
      const id = h.events.find((e) => e.type === "request.reserved")!.requestId!;
      seen.push((await h.ledger.getRequest(id))?.status);
    };
    await h.execute(body(), "streamGenerateContent", sink);
    expect(seen).toEqual(["reserved", "completed"]);
    expect(sink.ended).toBe(true);
  });

  it("marks a stream with no usage uncertain and fails it, as the native adapter does", async () => {
    const h = await gemini({
      fetch: async () =>
        new Response(sse([{ candidates: [{ content: { parts: [{ text: "x" }] } }] }]), { status: 200 }),
    });
    await expect(h.execute(body())).rejects.toMatchObject({ status: 502 });
    expect(h.events.some((e) => e.type === "request.uncertain")).toBe(true);
  });

  it("relays a stream error frame, records its status code and never its message", async () => {
    const h = await gemini({
      fetch: async () =>
        new Response(
          sse([{ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: `quota for ${FAKE_GEMINI_KEY}` } }]),
          { status: 200 },
        ),
    });
    const sink = await h.execute(body());
    expect(await h.ledger.upstreamFailure(h.session.id)).toBe("RESOURCE_EXHAUSTED");
    expect(JSON.stringify(h.events)).not.toContain(FAKE_GEMINI_KEY);
    expect(sink.text()).toContain("RESOURCE_EXHAUSTED");
    expect(sink.text()).toContain("quota for [REDACTED]");
    expect(sink.text()).not.toContain(FAKE_GEMINI_KEY);
    expect(sink.ended).toBe(true);
  });

  it("redacts the Vertex token from a relayed error frame", async () => {
    const h = await gemini({
      model: VERTEX_US,
      fetch: async () =>
        new Response(
          sse([{ error: { code: 401, status: "UNAUTHENTICATED", message: `token ${FAKE_VERTEX_TOKEN}` } }]),
          {
            status: 200,
          },
        ),
    });
    const sink = await h.execute(body());
    expect(sink.text()).toContain("token [REDACTED]");
    expect(sink.text()).not.toContain(FAKE_VERTEX_TOKEN);
  });

  it("redacts the key from a non-stream reply and leaves a reply without it byte-for-byte", async () => {
    const reply = {
      candidates: [{ content: { role: "model", parts: [{ text: `echo ${FAKE_GEMINI_KEY}` }] }, finishReason: "STOP" }],
      usageMetadata: usage(20, 3),
    };
    const echoed = await gemini({ fetch: async () => Response.json(reply) });
    const sink = await echoed.execute(body(), "generateContent");
    expect(sink.text()).not.toContain(FAKE_GEMINI_KEY);
    expect(JSON.parse(sink.text()).candidates[0].content.parts[0].text).toBe("echo [REDACTED]");
    const plain = ' { "candidates": [], "usageMetadata": {"promptTokenCount": 5, "candidatesTokenCount": 1} } ';
    const untouched = await gemini({ fetch: async () => new Response(plain, { status: 200 }) });
    expect((await untouched.execute(body(), "generateContent")).text()).toBe(plain);
  });

  it("hands run steps nothing carrying the key, from a stream or a whole reply (detail capture on)", async () => {
    const submitted: unknown[] = [];
    const steps = { submit: (_capability: string, _runId: string, batch: unknown) => void submitted.push(batch) };
    const echo = (text: string) => ({
      candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
      usageMetadata: usage(10, 2),
    });
    const stream = await gemini({
      steps,
      fetch: async () => new Response(sse([echo(`said ${FAKE_GEMINI_KEY}`)]), { status: 200 }),
    });
    expect((await stream.execute(body())).text()).toContain("said [REDACTED]");
    const whole = await gemini({ steps, fetch: async () => Response.json(echo(`said ${FAKE_GEMINI_KEY}`)) });
    expect((await whole.execute(body(), "generateContent")).text()).not.toContain(FAKE_GEMINI_KEY);
    // Steps were produced (the request declares a function), and none carries the key.
    expect(submitted.length).toBeGreaterThan(0);
    expect(JSON.stringify(submitted)).toContain("said [REDACTED]");
    expect(JSON.stringify(submitted)).not.toContain(FAKE_GEMINI_KEY);
  });

  it("answers a rejected call with a fixed body, recording Google's status code only", async () => {
    const h = await gemini({
      fetch: async () =>
        Response.json(
          { error: { code: 400, status: "INVALID_ARGUMENT", message: `API key ${FAKE_GEMINI_KEY} not valid` } },
          { status: 400 },
        ),
    });
    const sink = await h.execute(body());
    expect(sink.status).toBe(400);
    expect(sink.text()).not.toContain(FAKE_GEMINI_KEY);
    expect(await h.ledger.upstreamFailure(h.session.id)).toBe("INVALID_ARGUMENT");
    expect(JSON.stringify(h.events)).not.toContain(FAKE_GEMINI_KEY);
  });

  it("releases a Vertex call when the project is unset or ADC fails, with fixed reasons and no token text", async () => {
    const unset = await gemini({ model: VERTEX_US, vertexProject: null });
    await expect(unset.execute(body())).rejects.toMatchObject({ status: 503, code: "upstream_unavailable" });
    expect(unset.events.find((e) => e.type === "request.released")?.reason).toBe("vertex_project_unset");
    const failing = await gemini({
      model: VERTEX_US,
      vertexToken: async () => {
        throw new Error(`could not refresh ${FAKE_VERTEX_TOKEN} from /home/user/.config/gcloud/adc.json`);
      },
    });
    const error = await failing.execute(body()).catch((e: unknown) => e);
    expect(error).toMatchObject({ status: 503, code: "upstream_unavailable" });
    expect(String((error as Error).message)).not.toContain(FAKE_VERTEX_TOKEN);
    expect(failing.events.find((e) => e.type === "request.released")?.reason).toBe("vertex_auth_unavailable");
    expect(JSON.stringify(failing.events)).not.toContain(FAKE_VERTEX_TOKEN);
    expect(JSON.stringify(failing.events)).not.toContain("adc.json");
    expect(unset.fetch).not.toHaveBeenCalled();
    expect(failing.fetch).not.toHaveBeenCalled();
  });

  it("refuses another model in the path and a refused web tool before any credential is resolved", async () => {
    const resolve = vi.fn(async () => FAKE_GEMINI_KEY);
    const h = await gemini({ credentials: { resolve } });
    await expect(
      h.proxy.execute(
        {
          bearer: h.session.capability,
          protocol: "gemini-generate-content",
          rawBody: JSON.stringify(body()),
          gemini: { surface: "ai-studio", model: "gemini-4-carbon", method: "streamGenerateContent" },
        },
        new TestSink(),
      ),
    ).rejects.toMatchObject({ status: 403, code: "model_not_allowed" });
    await expect(h.execute(body({ tools: [{ googleSearch: {} }] }))).rejects.toMatchObject({
      code: "web_tools_not_allowed",
    });
    expect(await h.ledger.requestRefusal(h.session.id)).toBe("model_not_allowed");
    expect(resolve).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("writes no key, token or capability to stdout or stderr on the success and failure paths", async () => {
    const written: string[] = [];
    const capture = (chunk: unknown) => {
      written.push(String(chunk));
      return true;
    };
    const out = vi.spyOn(process.stdout, "write").mockImplementation(capture);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(capture);
    const capabilities: string[] = [];
    try {
      const studio = await gemini();
      capabilities.push(studio.session.capability);
      await studio.execute(body());
      const rejected = await gemini({
        fetch: async () =>
          Response.json({ error: { status: "PERMISSION_DENIED", message: FAKE_GEMINI_KEY } }, { status: 403 }),
      });
      capabilities.push(rejected.session.capability);
      await rejected.execute(body());
      const failing = await gemini({
        model: VERTEX_US,
        vertexToken: async () => {
          throw new Error(`refresh failed for ${FAKE_VERTEX_TOKEN}`);
        },
      });
      capabilities.push(failing.session.capability);
      await failing.execute(body()).catch(() => undefined);
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
    const text = written.join("");
    for (const secret of [FAKE_GEMINI_KEY, FAKE_VERTEX_TOKEN, ...capabilities]) expect(text).not.toContain(secret);
  });

  it("keeps the key, token and capability out of every audit event", async () => {
    const studio = await gemini();
    await studio.execute(body());
    const vertex = await gemini({ model: VERTEX_US });
    await vertex.execute(body());
    for (const h of [studio, vertex]) {
      const text = JSON.stringify(h.events);
      for (const secret of [FAKE_GEMINI_KEY, FAKE_VERTEX_TOKEN, h.session.capability]) {
        expect(text).not.toContain(secret);
      }
    }
  });
});

describe("retries", () => {
  it("sends a retried body again after Google rejected it, without an idempotency header", async () => {
    let calls = 0;
    const h = await gemini({
      fetch: async () =>
        ++calls === 1
          ? Response.json({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }, { status: 429 })
          : okStream(),
    });
    expect((await h.execute(body())).status).toBe(429);
    expect((await h.execute(body())).status).toBe(200);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    await expect(h.execute(body())).rejects.toMatchObject({ status: 409, code: "duplicate_completed" });
    // A new attempt of a released row is not a takeover: nothing was orphaned.
    expect(h.events.some((e) => e.type === "request.taken_over")).toBe(false);
    const attempts = h.events.filter((e) => e.type === "request.reserved").map((e) => e.requestId!);
    expect(await Promise.all(attempts.map(async (id) => (await h.ledger.getRequest(id))?.attempt))).toEqual([1, 2]);
  });
});
