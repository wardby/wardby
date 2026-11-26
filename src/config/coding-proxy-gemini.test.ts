import { describe, expect, it } from "vitest";
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

  it("refuses a value that is not a project id, naming the variable", () => {
    expect(() => loadCodingProxyGeminiConfig({ CODING_VERTEX_PROJECT: "Bad/Project" })).toThrow(
      "CODING_VERTEX_PROJECT",
    );
    expect(() => loadCodingProxyGeminiConfig({ VERTEX_PROJECT: "x" })).toThrow("VERTEX_PROJECT");
  });

  it("never echoes the rejected value", () => {
    expect(() => loadCodingProxyGeminiConfig({ CODING_VERTEX_PROJECT: "Bad/SecretValue" })).not.toThrow(/SecretValue/);
  });
});
