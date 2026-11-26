import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../core/logger.js";
import { loadCodingProxyGeminiConfig } from "./coding-proxy-gemini.js";

describe("loadCodingProxyGeminiConfig", () => {
  it("prefers CODING_VERTEX_PROJECT, then VERTEX_PROJECT, then GOOGLE_CLOUD_PROJECT", () => {
    expect(loadCodingProxyGeminiConfig({})).toEqual({});
    expect(loadCodingProxyGeminiConfig({ GOOGLE_CLOUD_PROJECT: "gcp-project-1" })).toEqual({
      vertexProject: "gcp-project-1",
    });
    expect(
      loadCodingProxyGeminiConfig({ VERTEX_PROJECT: "vertex-project", GOOGLE_CLOUD_PROJECT: "gcp-project-1" }),
    ).toEqual({ vertexProject: "vertex-project" });
    expect(
      loadCodingProxyGeminiConfig({ CODING_VERTEX_PROJECT: "coding-project", VERTEX_PROJECT: "vertex-project" }),
    ).toEqual({ vertexProject: "coding-project" });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses an invalid CODING_VERTEX_PROJECT, naming the variable", () => {
    expect(() => loadCodingProxyGeminiConfig({ CODING_VERTEX_PROJECT: "Bad/Project" })).toThrow(
      "CODING_VERTEX_PROJECT",
    );
  });

  it.each(["VERTEX_PROJECT", "GOOGLE_CLOUD_PROJECT"] as const)(
    "skips an invalid %s fallback with one warning naming the variable, never its value, and leaves Vertex unset",
    (name) => {
      const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      expect(loadCodingProxyGeminiConfig({ [name]: "Bad/SecretValue" })).toEqual({});
      expect(warn).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(warn.mock.calls[0]);
      expect(logged).toContain(name);
      expect(logged).not.toContain("SecretValue");
    },
  );

  it("does not fall through to GOOGLE_CLOUD_PROJECT when VERTEX_PROJECT is invalid", () => {
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    expect(loadCodingProxyGeminiConfig({ VERTEX_PROJECT: "x", GOOGLE_CLOUD_PROJECT: "gcp-project-1" })).toEqual({});
  });

  it("never echoes the rejected value", () => {
    expect(() => loadCodingProxyGeminiConfig({ CODING_VERTEX_PROJECT: "Bad/SecretValue" })).not.toThrow(/SecretValue/);
  });
});
