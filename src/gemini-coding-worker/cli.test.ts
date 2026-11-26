import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { googleModelId } from "../providers/coding-proxy/gemini-request.js";
import { shippedCatalog } from "../providers/llm/catalog.js";
import { GOOGLE_AI_STUDIO_PREFIX } from "../providers/llm/google-ai-studio.js";
import {
  AI_STUDIO_MODEL_PREFIX,
  GEMINI_CLI_INTEGRITY,
  GEMINI_CLI_PACKAGE,
  GEMINI_CLI_VERSION,
  GEMINI_HELPER_ALIASES,
  geminiCliModel,
} from "./cli.js";

const json = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

describe("Gemini CLI pin", () => {
  it("pins exactly the version the driver was tested with, with lockfile integrity", () => {
    const pkg = json("./package.json");
    const lock = json("./package-lock.json");
    expect(pkg.dependencies[GEMINI_CLI_PACKAGE]).toBe(GEMINI_CLI_VERSION);
    expect(lock.packages[`node_modules/${GEMINI_CLI_PACKAGE}`]).toMatchObject({
      version: GEMINI_CLI_VERSION,
      integrity: GEMINI_CLI_INTEGRITY,
    });
  });

  it("uses the Codex worker's versions of every shared runtime dependency", () => {
    const gemini = json("./package.json").dependencies as Record<string, string>;
    const codex = json("../coding-worker/package.json").dependencies as Record<string, string>;
    const shared = Object.keys(codex).filter((name) => name !== "@openai/codex-sdk");
    expect(Object.fromEntries(shared.map((name) => [name, gemini[name]]))).toEqual(
      Object.fromEntries(shared.map((name) => [name, codex[name]])),
    );
    expect(Object.keys(gemini).sort()).toEqual([...shared, GEMINI_CLI_PACKAGE].sort());
  });

  it("lists the 22 helper aliases of 0.70.0 once each", () => {
    expect(GEMINI_HELPER_ALIASES).toHaveLength(22);
    expect(new Set(GEMINI_HELPER_ALIASES).size).toBe(22);
  });
});

describe("geminiCliModel", () => {
  it("agrees with the proxy's mapping for every Gemini catalog model", () => {
    expect(AI_STUDIO_MODEL_PREFIX).toBe(GOOGLE_AI_STUDIO_PREFIX);
    const entries = shippedCatalog()
      .entries()
      .filter((entry) => entry.provider === "google-ai-studio" || entry.provider === "vertex-gemini");
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const mapped = geminiCliModel(entry.modelId);
      expect(mapped.backend, entry.modelId).toBe(entry.provider === "vertex-gemini" ? "vertex" : "ai-studio");
      expect(mapped.googleModel, entry.modelId).toBe(
        googleModelId(entry.modelId, entry.provider as "google-ai-studio" | "vertex-gemini"),
      );
    }
  });

  it("maps the three id shapes", () => {
    expect(geminiCliModel("google-ai-studio.gemini-4-neon")).toEqual({
      backend: "ai-studio",
      googleModel: "gemini-4-neon",
    });
    expect(geminiCliModel("us.gemini-4-neon")).toEqual({ backend: "vertex", googleModel: "gemini-4-neon" });
    expect(geminiCliModel("gemini-4-neon")).toEqual({ backend: "vertex", googleModel: "gemini-4-neon" });
  });
});
