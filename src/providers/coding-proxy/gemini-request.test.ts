import { describe, expect, it } from "vitest";
import {
  GEMINI_UNSET_MAX_OUTPUT_TOKENS,
  googleModelId,
  parseGeminiRequest,
  type GeminiParseContext,
} from "./gemini-request.js";
import { codeOf, recordedGemini } from "./gemini.test-support.js";

const ctx = (change: Partial<GeminiParseContext> = {}): GeminiParseContext => ({
  route: { surface: "ai-studio", model: "gemini-4-neon", method: "streamGenerateContent" },
  backend: "google-ai-studio",
  allowedModels: ["google-ai-studio.gemini-4-neon"],
  efforts: ["low", "medium", "high", "xhigh"],
  webTools: "off",
  maxBodyBytes: 8 * 1024 * 1024,
  maxOutputTokens: 1_000_000,
  ...change,
});
const body = (extra: Record<string, unknown> = {}) => ({
  contents: [{ role: "user", parts: [{ text: "hello" }] }],
  tools: [
    {
      functionDeclarations: [
        { name: "run_shell_command", description: "Run", parametersJsonSchema: { type: "object" } },
      ],
    },
  ],
  generationConfig: { maxOutputTokens: 1000, thinkingConfig: { thinkingLevel: "HIGH" } },
  ...extra,
});
const parse = (value: unknown, change?: Partial<GeminiParseContext>) =>
  parseGeminiRequest(JSON.stringify(value), ctx(change));
const refused = (value: unknown, code: string, change?: Partial<GeminiParseContext>) =>
  expect(codeOf(() => parse(value, change))).toBe(code);

describe("googleModelId", () => {
  it("strips the AI Studio prefix and the Vertex region prefix", () => {
    expect(googleModelId("google-ai-studio.gemini-4-neon", "google-ai-studio")).toBe("gemini-4-neon");
    expect(googleModelId("eu.gemini-4-neon", "vertex-gemini")).toBe("gemini-4-neon");
    expect(googleModelId("gemini-4-neon", "vertex-gemini")).toBe("gemini-4-neon");
  });
});

describe("parseGeminiRequest", () => {
  it("maps the path model to the session's wardby id and keeps the content", () => {
    const parsed = parse(body());
    expect(parsed.model).toBe("google-ai-studio.gemini-4-neon");
    expect(parsed.stream).toBe(true);
    expect(parsed.maxOutputTokens).toBe(1000);
    expect(JSON.parse(parsed.encoded)).toEqual(body());
  });

  it("lets a different path model fall through to model_not_allowed (returned as the path model)", () => {
    expect(
      parse(body(), { route: { surface: "ai-studio", model: "gemini-4-carbon", method: "generateContent" } }).model,
    ).toBe("gemini-4-carbon");
  });

  it("returns the CLI's built-in helper alias unmapped, so the proxy refuses it model_not_allowed (phase 3 remaps aliases)", () => {
    const parsed = parse(body(), {
      route: { surface: "ai-studio", model: "gemini-3-flash-preview", method: "generateContent" },
    });
    expect(parsed.model).toBe("gemini-3-flash-preview");
    expect(ctx().allowedModels).not.toContain(parsed.model);
  });

  it("holds an unset output cap at the model limit, without adding one to the body", () => {
    const parsed = parse(body({ generationConfig: {} }));
    expect(parsed.maxOutputTokens).toBe(GEMINI_UNSET_MAX_OUTPUT_TOKENS);
    expect(JSON.parse(parsed.encoded).generationConfig).toEqual({});
  });

  it("forwards the value it validated when a key is duplicated", () => {
    const raw = `{"contents":[{"role":"user","parts":[{"text":"x"}]}],"tools":[{"urlContext":{}}],"tools":[]}`;
    const parsed = parseGeminiRequest(raw, ctx());
    expect(JSON.parse(parsed.encoded).tools).toEqual([]);
    expect(parsed.encoded).not.toContain("urlContext");
  });

  it("refuses the wrong surface for the session's backend", () => {
    refused(body(), "gemini_backend_mismatch", {
      route: { surface: "vertex-express", model: "gemini-4-neon", method: "generateContent" },
    });
  });

  it("applies the web-tool policy to googleSearch and urlContext", () => {
    const search = body({ tools: [{ googleSearch: {} }] });
    const fetch = body({ tools: [{ urlContext: {} }] });
    refused(search, "web_tools_not_allowed");
    refused(fetch, "web_tools_not_allowed", { webTools: "search" });
    expect(parse(search, { webTools: "search" }).model).toBeDefined();
    expect(parse(fetch, { webTools: "search-and-fetch" }).model).toBeDefined();
    refused(body({ tools: [{ googleSearch: { excludeDomains: ["a"] } }] }), "invalid_gemini_tool", {
      webTools: "search",
    });
  });

  it("refuses googleSearch and urlContext under a web-tool policy it does not know", () => {
    const unknown = { webTools: "search-everything" as unknown as GeminiParseContext["webTools"] };
    refused(body({ tools: [{ googleSearch: {} }] }), "web_tools_not_allowed", unknown);
    refused(body({ tools: [{ urlContext: {} }] }), "web_tools_not_allowed", unknown);
  });

  it("maps a Vertex path model to the session's region-prefixed wardby id", () => {
    const route = { surface: "vertex-express" as const, model: "gemini-4-neon", method: "streamGenerateContent" };
    for (const id of ["us.gemini-4-neon", "eu.gemini-4-neon"]) {
      expect(parse(body(), { route, backend: "vertex-gemini", allowedModels: [id] }).model).toBe(id);
    }
  });

  it("refuses every other server-side tool and server-fetched part", () => {
    for (const tool of [
      { codeExecution: {} },
      { googleSearchRetrieval: {} },
      { googleMaps: {} },
      { retrieval: {} },
      { urlContext: {}, googleSearch: {} },
    ]) {
      refused(body({ tools: [tool] }), Object.keys(tool).length > 1 ? "invalid_gemini_tool" : "tools_not_allowed", {
        webTools: "search-and-fetch",
      });
    }
    refused(
      body({
        contents: [
          { role: "user", parts: [{ fileData: { fileUri: "https://example.com/x", mimeType: "text/html" } }] },
        ],
      }),
      "gemini_part_not_allowed",
    );
    refused(
      body({ contents: [{ role: "model", parts: [{ executableCode: { code: "x" } }] }] }),
      "gemini_part_not_allowed",
    );
    refused(body({ cachedContent: "cachedContents/abc" }), "invalid_gemini_request");
  });

  it("refuses more than one candidate, unknown generation fields and an effort the model does not take", () => {
    refused(body({ generationConfig: { candidateCount: 2 } }), "invalid_gemini_generation_config");
    refused(body({ generationConfig: { responseModalities: ["IMAGE"] } }), "invalid_gemini_generation_config");
    refused(body({ generationConfig: { thinkingConfig: { thinkingLevel: "MAX" } } }), "unsupported_effort");
    refused(body({ generationConfig: { maxOutputTokens: 0 } }), "invalid_max_output_tokens");
  });

  it("refuses malformed bodies with fixed codes", () => {
    refused({}, "invalid_gemini_request");
    refused({ contents: [] }, "invalid_gemini_request");
    refused({ contents: [{ role: "tool", parts: [{ text: "x" }] }] }, "invalid_gemini_content");
    expect(codeOf(() => parseGeminiRequest("{", ctx()))).toBe("invalid_json");
    expect(codeOf(() => parseGeminiRequest("x".repeat(9 * 1024 * 1024), ctx()))).toBe("payload_too_large");
  });

  it("fingerprints surface, method and path model with the body", () => {
    const a = parse(body());
    const b = parse(body(), { route: { surface: "ai-studio", model: "gemini-4-neon", method: "generateContent" } });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it("accepts every recorded Gemini CLI request when its web tools are allowed, and refuses only the web helpers when off", async () => {
    for (const r of await recordedGemini()) {
      const route = { surface: r.surface, model: "gemini-4-neon", method: r.method };
      const backend = r.surface === "ai-studio" ? "google-ai-studio" : "vertex-gemini";
      const allowedModels = [r.surface === "ai-studio" ? "google-ai-studio.gemini-4-neon" : "gemini-4-neon"];
      const on = parseGeminiRequest(
        JSON.stringify(r.body),
        ctx({ route, backend, allowedModels, webTools: "search-and-fetch" }),
      );
      expect(JSON.parse(on.encoded), r.scenario).toEqual(r.body);
      const web = (r.body.tools as Record<string, unknown>[] | undefined)?.some(
        (t) => "googleSearch" in t || "urlContext" in t,
      );
      const off = codeOf(() => parseGeminiRequest(JSON.stringify(r.body), ctx({ route, backend, allowedModels })));
      expect(off, r.scenario).toBe(web ? "web_tools_not_allowed" : undefined);
    }
  });
});
