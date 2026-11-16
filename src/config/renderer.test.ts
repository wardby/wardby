import { describe, expect, it } from "vitest";
import { loadRendererConfig } from "./renderer.js";

describe("loadRendererConfig", () => {
  it("is off when WARDBY_RENDERER_URL is unset or blank", () => {
    expect(loadRendererConfig({})).toEqual({ url: null, deployment: "wardby-renderer" });
    expect(loadRendererConfig({ WARDBY_RENDERER_URL: "  " }).url).toBeNull();
  });

  it("refuses a non-http(s) URL", () => {
    expect(() => loadRendererConfig({ WARDBY_RENDERER_URL: "ftp://x" })).toThrow(/WARDBY_RENDERER_URL/);
    expect(() => loadRendererConfig({ WARDBY_RENDERER_URL: "not a url" })).toThrow(/WARDBY_RENDERER_URL/);
  });

  it("refuses a URL with credentials and never echoes them", () => {
    let message = "";
    try {
      loadRendererConfig({ WARDBY_RENDERER_URL: "http://user:FAKE-RENDERER-PASS@r:8796" });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/WARDBY_RENDERER_URL/);
    expect(message).not.toContain("FAKE-RENDERER-PASS");
  });

  it("drops a trailing slash", () => {
    expect(loadRendererConfig({ WARDBY_RENDERER_URL: "http://r:8796/" }).url).toBe("http://r:8796");
    expect(loadRendererConfig({ WARDBY_RENDERER_URL: "https://r.example/base//" }).url).toBe("https://r.example/base");
  });

  it("reads RENDERER_DEPLOYMENT", () => {
    expect(loadRendererConfig({ RENDERER_DEPLOYMENT: "my-renderer" }).deployment).toBe("my-renderer");
  });
});
