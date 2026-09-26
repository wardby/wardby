import { describe, expect, it } from "vitest";
import { boundedMetadataFetch } from "./bounded-fetch.js";

const URL_ = "https://registry.npmjs.org/react";

describe("boundedMetadataFetch", () => {
  it("returns the body in memory when it fits", async () => {
    const fetch = boundedMetadataFetch(async () => Response.json({ ok: true }), { timeoutMs: 1_000, maxBytes: 1_000 });
    await expect((await fetch(URL_)).json()).resolves.toEqual({ ok: true });
  });

  it("times out a request that never answers with 504 wardby_upstream_unavailable", async () => {
    const fetch = boundedMetadataFetch(
      (_url, init) =>
        new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error))),
      { timeoutMs: 20, maxBytes: 1_000 },
    );
    await expect(fetch(URL_)).rejects.toMatchObject({ status: 504, code: "wardby_upstream_unavailable" });
  });

  it("times out a body that stalls, even when the upstream ignores the signal", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"));
      },
    });
    const fetch = boundedMetadataFetch(async () => new Response(stalled), { timeoutMs: 20, maxBytes: 1_000 });
    await expect(fetch(URL_)).rejects.toMatchObject({ status: 504, code: "wardby_upstream_unavailable" });
  });

  it("refuses a body over the cap, by declared length or while reading", async () => {
    const declared = boundedMetadataFetch(
      async () => new Response("x".repeat(2_000), { headers: { "content-length": "2000" } }),
      { timeoutMs: 1_000, maxBytes: 1_000 },
    );
    await expect(declared(URL_)).rejects.toMatchObject({ status: 502, code: "wardby_metadata_too_large" });
    const streamed = boundedMetadataFetch(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array(600));
            },
          }),
        ),
      { timeoutMs: 1_000, maxBytes: 1_000 },
    );
    await expect(streamed(URL_)).rejects.toMatchObject({ status: 502, code: "wardby_metadata_too_large" });
  });
});
