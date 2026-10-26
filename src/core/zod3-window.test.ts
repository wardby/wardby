import { describe, expect, it } from "vitest";
import {
  cachedZod4Compatibility,
  clearZod4CompatibilityCache,
  logZod3ToolWarnings,
  toolSubject,
  withZod3ToolWarnings,
  zod3SampleArgsWarning,
  zod3ToolWarnings,
} from "./zod3-window.js";

// A fake value in the schema text: no warning may carry the schema's content.
const FAKE_SECRET = "sk-fake-0123456789abcdef";
const ZOD3_ONLY = `z.object({ city: z.string().describe("${FAKE_SECRET}"), note: z.ostring() }).nonstrict()`;
const ZOD4_OK = "z.object({ city: z.string(), days: z.number().max(10) })";

describe("Zod 3 window warnings", () => {
  it("names the tool and the removed API, says when Zod 3 schemas stop working, and nothing else", async () => {
    const [warning, ...rest] = await zod3ToolWarnings(toolSubject("weather"), ZOD3_ONLY);
    expect(rest).toEqual([]);
    expect(warning).toBe(
      `Tool "weather"'s paramsZod uses Zod 3 API that Zod 4 removed: z.ostring(), .nonstrict(). ` +
        "Wardby still compiles it with Zod 3 in this release, but Zod 3 schemas stop working in the next release: " +
        "rewrite it with the Zod 4 API and check it with dry_run_tool.",
    );
    expect(warning).not.toContain(FAKE_SECRET);
    expect(warning).not.toContain("city");
  });

  it("says nothing about a schema Zod 4 compiles", async () => {
    expect(await zod3ToolWarnings(toolSubject("weather"), ZOD4_OK)).toEqual([]);
  });

  it("compares how Zod 3 and Zod 4 treat dry_run_tool's sample arguments, naming no values", () => {
    const accepted = { ok: true as const, value: { a: FAKE_SECRET } };
    const rejected = { ok: false as const, errorKind: "thrown" as const, errorMessage: `ZodError: ${FAKE_SECRET}` };
    expect(zod3SampleArgsWarning("This paramsZod", accepted, accepted)).toBeUndefined();
    expect(zod3SampleArgsWarning("This paramsZod", rejected, rejected)).toBeUndefined();
    const warning = zod3SampleArgsWarning("This paramsZod", accepted, rejected);
    expect(warning).toMatch(/^This paramsZod rejects the sample arguments with Zod 4\. /);
    expect(warning).toContain("Zod 3 schemas stop working in the next release");
    expect(warning).not.toContain(FAKE_SECRET);
    expect(zod3SampleArgsWarning("This paramsZod", accepted, { ok: true, value: {} })).toMatch(/different value/);
  });

  it("logs one warning per stored tool Zod 4 can't compile, with no schema content", async () => {
    const tools = [
      { id: "t1", name: "old", paramsZod: ZOD3_ONLY },
      { id: "t2", name: "new", paramsZod: ZOD4_OK },
    ];
    const db = { tool: { findMany: async () => tools } } as never;
    const lines: { fields: object; message: string }[] = [];
    const warned = await logZod3ToolWarnings(db, { warn: (fields, message) => lines.push({ fields, message }) });
    expect(warned).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0].fields).toEqual({ toolId: "t1", toolName: "old", removed: ["z.ostring()", ".nonstrict()"] });
    expect(lines[0].message).toMatch(/^Tool "old"'s paramsZod uses Zod 3 API/);
    expect(JSON.stringify(lines)).not.toContain(FAKE_SECRET);
  });

  it("never throws when the tools can't be read", async () => {
    const db = {
      tool: {
        findMany: async () => {
          throw new Error(`connection to postgres://user:${FAKE_SECRET}@db failed`);
        },
      },
    } as never;
    const lines: { fields: object; message: string }[] = [];
    expect(await logZod3ToolWarnings(db, { warn: (fields, message) => lines.push({ fields, message }) })).toBe(0);
    expect(lines).toEqual([{ fields: { errorName: "Error" }, message: "zod3_window_check_failed" }]);
  });

  it("caches compatibility by the paramsZod text, so a changed schema is always probed again", async () => {
    clearZod4CompatibilityCache();
    const first = cachedZod4Compatibility(ZOD3_ONLY);
    expect(cachedZod4Compatibility(ZOD3_ONLY)).toBe(first);
    expect(await first).toEqual({ compatible: false, removed: ["z.ostring()", ".nonstrict()"] });
    expect(await cachedZod4Compatibility(ZOD4_OK)).toEqual({ compatible: true });
    // An "unknown" result is not kept.
    const invalid = cachedZod4Compatibility("not valid {{{");
    expect(await invalid).toEqual({ compatible: "unknown" });
    expect(cachedZod4Compatibility("not valid {{{")).not.toBe(invalid);
  });

  it("adds warnings only to a row that carries its paramsZod (the caller's own tool)", async () => {
    expect(await withZod3ToolWarnings({ id: "t", name: "old", paramsZod: ZOD3_ONLY })).toMatchObject({
      warnings: [expect.stringMatching(/^Tool "old"'s paramsZod uses Zod 3 API/)],
    });
    expect(await withZod3ToolWarnings({ id: "t", name: "old", description: "d", public: true })).toEqual({
      id: "t",
      name: "old",
      description: "d",
      public: true,
    });
  });
});
