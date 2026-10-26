import { describe, expect, it } from "vitest";
import { z } from "zod";
import { deriveJsonSchema, validateParams, zod4Compatibility } from "./zod-params.js";
import { ToolCapabilitiesPatchSchema } from "./tool-capabilities.js";

const CITY_DAYS_SCHEMA = "z.object({ city: z.string(), days: z.number().max(10) })";

describe("deriveJsonSchema", () => {
  it("derives JSON Schema matching the Zod shape", async () => {
    const result = await deriveJsonSchema(CITY_DAYS_SCHEMA);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const schema = result.value as any;
      expect(schema.type).toBe("object");
      expect(schema.properties.city).toEqual({ type: "string" });
      expect(schema.properties.days).toEqual({ type: "number", maximum: 10 });
      expect(schema.required).toEqual(["city", "days"]);
    }
  });

  it("keeps the JSON Schema a Zod 3 tool schema derived before the Zod 4 upgrade", async () => {
    // Expected values: zod-to-json-schema 3.25.2's output for the same source under Zod 3.25.76.
    const cases: [string, unknown][] = [
      [
        "z.object({ a: z.string().min(1).max(5).describe('A'), b: z.number().int().optional(), c: z.boolean().default(false), d: z.enum(['x','y']), e: z.array(z.string()).max(3), f: z.string().nullable() })",
        {
          type: "object",
          properties: {
            a: { type: "string", minLength: 1, maxLength: 5, description: "A" },
            b: { type: "integer" },
            c: { type: "boolean", default: false },
            d: { type: "string", enum: ["x", "y"] },
            e: { type: "array", items: { type: "string" }, maxItems: 3 },
            f: { type: ["string", "null"] },
          },
          required: ["a", "d", "e", "f"],
          additionalProperties: false,
          $schema: "http://json-schema.org/draft-07/schema#",
        },
      ],
      [
        "z.object({ r: z.record(z.string(), z.number()), u: z.union([z.string(), z.number()]), l: z.literal('k'), url: z.string().url(), re: z.string().regex(/^a+$/) })",
        {
          type: "object",
          properties: {
            r: { type: "object", additionalProperties: { type: "number" } },
            u: { type: ["string", "number"] },
            l: { type: "string", const: "k" },
            url: { type: "string", format: "uri" },
            re: { type: "string", pattern: "^a+$" },
          },
          required: ["r", "u", "l", "url", "re"],
          additionalProperties: false,
          $schema: "http://json-schema.org/draft-07/schema#",
        },
      ],
      [
        "z.object({ nested: z.object({ x: z.number() }).optional(), arr: z.array(z.object({ y: z.string() })), p: z.object({ q: z.string() }).passthrough(), t: z.string().transform((s) => s.length) })",
        {
          type: "object",
          properties: {
            nested: {
              type: "object",
              properties: { x: { type: "number" } },
              required: ["x"],
              additionalProperties: false,
            },
            arr: {
              type: "array",
              items: {
                type: "object",
                properties: { y: { type: "string" } },
                required: ["y"],
                additionalProperties: false,
              },
            },
            p: { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: true },
            t: { type: "string" },
          },
          required: ["arr", "p", "t"],
          additionalProperties: false,
          $schema: "http://json-schema.org/draft-07/schema#",
        },
      ],
      [
        "z.discriminatedUnion('t', [z.object({ t: z.literal('a'), v: z.string() }), z.object({ t: z.literal('b'), n: z.number() }).strict()])",
        {
          anyOf: [
            {
              type: "object",
              properties: { t: { type: "string", const: "a" }, v: { type: "string" } },
              required: ["t", "v"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: { t: { type: "string", const: "b" }, n: { type: "number" } },
              required: ["t", "n"],
              additionalProperties: false,
            },
          ],
          $schema: "http://json-schema.org/draft-07/schema#",
        },
      ],
    ];
    // Zod 3 window: zod-to-json-schema itself under zod/v3 (the default), and
    // the Zod 4 path the next release switches to.
    for (const apis of [undefined, ["v4"] as const]) {
      for (const [source, expected] of cases) {
        const result = await deriveJsonSchema(source, apis);
        expect(result).toEqual({ ok: true, value: expected });
      }
    }
  });

  it("fails at registration (not later) for malformed schema source", async () => {
    const result = await deriveJsonSchema("this is not valid javascript {{{");
    expect(result.ok).toBe(false);
  });

  it("fails for source that doesn't produce a Zod schema", async () => {
    const result = await deriveJsonSchema("{ notASchema: true }");
    expect(result.ok).toBe(false);
  });
});

describe("validateParams", () => {
  it("passes through a valid argument set", async () => {
    const result = await validateParams(CITY_DAYS_SCHEMA, { city: "Boston", days: 3 });
    expect(result).toEqual({ ok: true, value: { city: "Boston", days: 3 } });
  });

  it("produces a validation error result for invalid args, not a crash", async () => {
    const result = await validateParams(CITY_DAYS_SCHEMA, { city: "Boston", days: 30 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorKind).toBe("thrown");
      expect(result.errorMessage).toMatch(/days/);
    }
  });

  it("rejects missing required fields", async () => {
    const result = await validateParams(CITY_DAYS_SCHEMA, { city: "Boston" });
    expect(result.ok).toBe(false);
  });

  it("rejects extra unrecognized args passed as the wrong type", async () => {
    const result = await validateParams(CITY_DAYS_SCHEMA, { city: 42, days: 3 });
    expect(result.ok).toBe(false);
  });
});

// A schema written for Zod 3 with API Zod 4 removed.
const ZOD3_ONLY_SCHEMA = "z.object({ city: z.string(), note: z.ostring() }).nonstrict()";

describe("Zod 3 compatibility window", () => {
  it("still validates calls against a Zod 3-only schema, with Zod 3's semantics", async () => {
    expect(await validateParams(ZOD3_ONLY_SCHEMA, { city: "Boston", extra: 1 })).toEqual({
      ok: true,
      value: { city: "Boston", extra: 1 },
    });
    const bad = await validateParams(ZOD3_ONLY_SCHEMA, { city: "Boston", note: 5 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errorMessage).toMatch(/note/);
  });

  it("derives a Zod 3-only schema's JSON Schema as before the upgrade", async () => {
    expect(await deriveJsonSchema(ZOD3_ONLY_SCHEMA)).toEqual({
      ok: true,
      value: {
        type: "object",
        properties: { city: { type: "string" }, note: { type: "string" } },
        required: ["city"],
        additionalProperties: true,
        $schema: "http://json-schema.org/draft-07/schema#",
      },
    });
  });

  it("falls back to Zod 4 for a schema Zod 3 can't compile", async () => {
    const source = "z.object({ to: z.email(), opts: z.looseObject({}) })";
    expect(await validateParams(source, { to: "a@example.com", opts: { x: 1 } })).toEqual({
      ok: true,
      value: { to: "a@example.com", opts: { x: 1 } },
    });
    const bad = await validateParams(source, { to: "nope", opts: {} });
    expect(bad.ok).toBe(false);
    const schema = await deriveJsonSchema(source);
    expect(schema.ok).toBe(true);
    if (schema.ok) expect(JSON.stringify(schema.value)).toContain('"format":"email"');
  });

  it("reports the first API's compile error, without its internal marker, when no API compiles it", async () => {
    const result = await validateParams("z.object({ a: z.notAThing() })", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorKind).toBe("thrown");
      expect(result.errorMessage).toMatch(/^TypeError: /);
      expect(result.errorMessage).not.toContain("__wardby");
    }
  });

  it("names the removed Zod 3 API a schema uses", async () => {
    expect(await zod4Compatibility(ZOD3_ONLY_SCHEMA)).toEqual({
      compatible: false,
      removed: ["z.ostring()", ".nonstrict()"],
    });
    expect(
      await zod4Compatibility(
        "z.object({ ip: z.string().ip(), n: z.onumber(), d: z.object({ x: z.number() }).deepPartial() })",
      ),
    ).toEqual({ compatible: false, removed: [".ip()", "z.onumber()", ".deepPartial()"] });
  });

  it("flags a Zod 3 schema Zod 4 can't compile even when it uses no API on the removed list", async () => {
    expect(await zod4Compatibility("z.object({ s: z.ZodString.create({}) })")).toEqual({
      compatible: false,
      removed: [],
    });
  });

  it("finds nothing to warn about in a schema Zod 4 compiles, or in one neither API compiles", async () => {
    expect(await zod4Compatibility(CITY_DAYS_SCHEMA)).toEqual({ compatible: true });
    expect(await zod4Compatibility("z.object({ e: z.email() })")).toEqual({ compatible: true });
    expect(await zod4Compatibility("not valid javascript {{{")).toEqual({ compatible: "unknown" });
  });

  it("bounds an oversized constrained array under Zod 3 by the sandbox limits (GHSA-mrhx-c7xc-m3w5)", async () => {
    // zod/v3 still walks every element of an array past its .max(), one issue per bad element.
    const schema = "z.object({ items: z.array(z.string()).max(10) })";
    const items = Array.from({ length: 1_000_000 }, (_, i) => i);
    const result = await validateParams(schema, { items }, ["v3"]);
    expect(result).toMatchObject({ ok: false, errorKind: "memory" });
    // Zod 4 rejects it on its size bound alone.
    const small = await validateParams(schema, { items: items.slice(0, 1000) }, ["v4"]);
    expect(small.ok).toBe(false);
    if (!small.ok) expect(small.errorMessage.match(/"code"/g)).toHaveLength(1);
  });

  it("leaves wardby's own schemas on Zod 4", () => {
    expect("_zod" in z.string()).toBe(true);
    expect("_zod" in ToolCapabilitiesPatchSchema).toBe(true);
    expect((z.string() as unknown as Record<string, unknown>).ip).toBeUndefined();
  });
});
