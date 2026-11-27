import { describe, expect, it } from "vitest";
import {
  GEMINI_DRIVER_VARIABLES,
  GEMINI_GUARD_VARIABLES,
  GEMINI_VERTEX_BLANKED,
  geminiReservedServiceVariable,
} from "./gemini-cli-env.js";
import { GEMINI_GUARD_VARIABLES as DRIVER_LIST } from "../gemini-coding-worker/environment.js";

const VERTEX_MODEL = "gemini-4-neon";
const AI_STUDIO_MODEL = "google-ai-studio.gemini-4-neon";

describe("Gemini CLI reserved service variables", () => {
  it("is the driver's own list, one copy", () => {
    expect(DRIVER_LIST).toBe(GEMINI_GUARD_VARIABLES);
    expect(GEMINI_GUARD_VARIABLES).toContain("GEMINI_SYSTEM_MD");
    expect(geminiReservedServiceVariable(["OTEL_SDK_DISABLED"], VERTEX_MODEL)).toBe("OTEL_SDK_DISABLED");
    expect(GEMINI_DRIVER_VARIABLES).toContain("GEMINI_API_KEY");
    expect(GEMINI_VERTEX_BLANKED).toEqual(["GOOGLE_CLOUD_LOCATION"]);
  });

  it("names the first reserved variable a service's testEnv sets, or nothing", () => {
    for (const model of [VERTEX_MODEL, AI_STUDIO_MODEL]) {
      expect(geminiReservedServiceVariable(["DATABASE_URL", "REDIS_URL"], model)).toBeUndefined();
      expect(geminiReservedServiceVariable(["OTEL_EXPORTER_OTLP_ENDPOINT", "DATABASE_URL"], model)).toBe(
        "OTEL_EXPORTER_OTLP_ENDPOINT",
      );
      expect(geminiReservedServiceVariable(["GEMINI_TELEMETRY_TARGET"], model)).toBe("GEMINI_TELEMETRY_TARGET");
      expect(geminiReservedServiceVariable(["GOOGLE_GEMINI_BASE_URL"], model)).toBe("GOOGLE_GEMINI_BASE_URL");
      expect(geminiReservedServiceVariable(["GEMINI_CLI_FUTURE_SWITCH"], model)).toBe("GEMINI_CLI_FUTURE_SWITCH");
      expect(geminiReservedServiceVariable(["ZED", "GEMINI_SANDBOX", "GEMINI_MODEL"], model)).toBe("GEMINI_MODEL");
    }
  });

  it("reserves GOOGLE_CLOUD_LOCATION on Vertex runs only, where the driver blanks it", () => {
    expect(geminiReservedServiceVariable(["GOOGLE_CLOUD_LOCATION"], VERTEX_MODEL)).toBe("GOOGLE_CLOUD_LOCATION");
    expect(geminiReservedServiceVariable(["GOOGLE_CLOUD_LOCATION"], "us.gemini-4-neon")).toBe("GOOGLE_CLOUD_LOCATION");
    expect(geminiReservedServiceVariable(["GOOGLE_CLOUD_LOCATION"], AI_STUDIO_MODEL)).toBeUndefined();
  });
});
