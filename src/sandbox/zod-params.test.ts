import { describe, expect, it } from "vitest";
import { deriveJsonSchema, validateParams } from "./zod-params.js";

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
    for (const [source, expected] of cases) {
      const result = await deriveJsonSchema(source);
      expect(result).toEqual({ ok: true, value: expected });
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
