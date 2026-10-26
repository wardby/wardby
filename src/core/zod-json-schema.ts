/**
 * Zod 4's JSON Schema converter (`z.toJSONSchema`) says a few things
 * differently from zod-to-json-schema, which wardby used with Zod 3. Each
 * difference means the same thing, so a schema derived with Zod 4 is rewritten
 * in the old spelling and the schemas wardby publishes (the viewer's schema
 * files and OpenAPI document) and sends to models (a tool's parameters) keep
 * their shape across the upgrade:
 *
 * - an integer carries Number.MAX_SAFE_INTEGER bounds: dropped;
 * - a discriminated union is a `oneOf`: written as `anyOf` (its branches'
 *   discriminators never overlap, so exactly one branch matches either way);
 * - a record carries `propertyNames: { type: "string" }`: dropped (JSON object
 *   keys are always strings);
 * - with `closeObjects` (input-mode schemas, where Zod 4 leaves a stripping
 *   object open): an object with `properties` and no `additionalProperties`
 *   gets `additionalProperties: false`, and an open one's `{}` becomes `true`.
 *
 * Pure: it only rewrites a JSON value.
 */
type Json = Record<string, unknown>;

export interface LegacyJsonSchemaOptions {
  closeObjects?: boolean;
}

function isStringKeySchema(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    (value as Json).type === "string"
  );
}

export function legacyJsonSchema(node: unknown, options: LegacyJsonSchemaOptions = {}): unknown {
  if (Array.isArray(node)) return node.map((item) => legacyJsonSchema(item, options));
  if (!node || typeof node !== "object") return node;
  const source = node as Json;
  const out: Json = {};
  for (const [key, value] of Object.entries(source)) {
    if (source.type === "integer" && key === "minimum" && value === Number.MIN_SAFE_INTEGER) continue;
    if (source.type === "integer" && key === "maximum" && value === Number.MAX_SAFE_INTEGER) continue;
    if (key === "propertyNames" && isStringKeySchema(value)) continue;
    if (
      options.closeObjects &&
      key === "additionalProperties" &&
      value &&
      typeof value === "object" &&
      Object.keys(value).length === 0
    ) {
      out[key] = true;
      continue;
    }
    // A `properties` map's keys are names, not keywords: only its values are schemas.
    out[key === "oneOf" ? "anyOf" : key] =
      key === "properties" && value && typeof value === "object"
        ? Object.fromEntries(Object.entries(value as Json).map(([name, sub]) => [name, legacyJsonSchema(sub, options)]))
        : legacyJsonSchema(value, options);
  }
  if (options.closeObjects && source.type === "object" && "properties" in source && !("additionalProperties" in source))
    out.additionalProperties = false;
  return out;
}
