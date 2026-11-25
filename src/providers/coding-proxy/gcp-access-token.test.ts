import { describe, expect, it } from "vitest";
import { GCP_TOKEN_URL, GcpTokenError, REFRESH_BEFORE_EXPIRY_MS, gcpAccessTokenSource } from "./gcp-access-token.js";

function metadata(responses: Array<() => Response | Promise<Response>>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: { ...(init?.headers as Record<string, string>) } });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next();
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const token =
  (value: string, expiresIn = 3600) =>
  () =>
    new Response(JSON.stringify({ access_token: value, expires_in: expiresIn, token_type: "Bearer" }), { status: 200 });

describe("gcpAccessTokenSource", () => {
  it("asks the metadata server for the pod's service account token, with the required header", async () => {
    const { calls, fetchImpl } = metadata([token("ya29.first")]);
    expect(await gcpAccessTokenSource({ fetch: fetchImpl })()).toBe("Bearer ya29.first");
    expect(calls).toEqual([{ url: GCP_TOKEN_URL, headers: { "Metadata-Flavor": "Google" } }]);
  });

  it("reuses the token until shortly before it expires, then fetches a new one", async () => {
    let now = 0;
    const { calls, fetchImpl } = metadata([token("ya29.first", 3600), token("ya29.second", 3600)]);
    const source = gcpAccessTokenSource({ fetch: fetchImpl, now: () => now });
    expect(await source()).toBe("Bearer ya29.first");
    now = 3600_000 - REFRESH_BEFORE_EXPIRY_MS - 1;
    expect(await source()).toBe("Bearer ya29.first");
    now = 3600_000 - REFRESH_BEFORE_EXPIRY_MS;
    expect(await source()).toBe("Bearer ya29.second");
    expect(calls).toHaveLength(2);
  });

  it("shares one fetch between concurrent requests", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { calls, fetchImpl } = metadata([
      async () => {
        await gate;
        return token("ya29.shared")();
      },
    ]);
    const source = gcpAccessTokenSource({ fetch: fetchImpl });
    const both = Promise.all([source(), source()]);
    release();
    expect(await both).toEqual(["Bearer ya29.shared", "Bearer ya29.shared"]);
    expect(calls).toHaveLength(1);
  });

  it("fails with a fixed code, never the response, and tries again on the next request", async () => {
    const { fetchImpl } = metadata([
      () => {
        throw new TypeError("fetch failed");
      },
      () => new Response("forbidden: secret detail", { status: 403 }),
      () => new Response("not json", { status: 200 }),
      () => new Response(JSON.stringify({ access_token: "has space", expires_in: 3600 }), { status: 200 }),
      () => new Response(JSON.stringify({ access_token: "ya29.x" }), { status: 200 }),
      token("ya29.recovered"),
    ]);
    const source = gcpAccessTokenSource({ fetch: fetchImpl });
    for (const code of [
      "metadata_unreachable",
      "metadata_http_403",
      "metadata_bad_response",
      "metadata_bad_response",
      "metadata_bad_response",
    ]) {
      const error = await source().catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(GcpTokenError);
      expect((error as GcpTokenError).code).toBe(code);
      expect(String(error)).not.toContain("secret detail");
    }
    expect(await source()).toBe("Bearer ya29.recovered");
  });
});
