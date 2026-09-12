import { describe, expect, it } from "vitest";
import {
  ToolCapabilitiesSchema,
  ToolCapabilitiesPatchSchema,
  asStringArray,
  asPrefixMap,
  FETCH_WILDCARD,
  MAX_ALLOWED_HOSTS,
  MAX_ALLOWED_SHARED_DATASTORES,
} from "./tool-capabilities.js";

describe("ToolCapabilitiesSchema", () => {
  it("defaults every field to an empty (deny-all) array or object", () => {
    const result = ToolCapabilitiesSchema.parse({});
    expect(result).toEqual({
      allowedSecrets: [],
      allowedDatastorePrefixes: [],
      allowedHosts: [],
      allowedSharedDatastorePrefixes: {},
    });
  });

  it("accepts the fetch wildcard alongside normalized hostnames, deduplicated", () => {
    const result = ToolCapabilitiesSchema.parse({
      allowedHosts: ["API.EXAMPLE.COM", "*", "api.example.com."],
    });
    expect(result.allowedHosts.sort()).toEqual([FETCH_WILDCARD, "api.example.com"]);
  });

  it("rejects an unnormalizable host", () => {
    expect(() => ToolCapabilitiesSchema.parse({ allowedHosts: ["not a host!"] })).toThrow();
  });

  it("rejects more than the max allowed hosts", () => {
    const hosts = Array.from({ length: MAX_ALLOWED_HOSTS + 1 }, (_, i) => `host${i}.example.com`);
    expect(() => ToolCapabilitiesSchema.parse({ allowedHosts: hosts })).toThrow();
  });

  it("accepts an empty-string datastore prefix (matches every key)", () => {
    const result = ToolCapabilitiesSchema.parse({ allowedDatastorePrefixes: [""] });
    expect(result.allowedDatastorePrefixes).toEqual([""]);
  });

  it("rejects unknown fields", () => {
    expect(() => ToolCapabilitiesSchema.parse({ nope: true })).toThrow();
  });
});

describe("ToolCapabilitiesPatchSchema", () => {
  it("leaves every field undefined when nothing is passed", () => {
    const result = ToolCapabilitiesPatchSchema.parse({});
    expect(result).toEqual({});
  });

  it("validates only the fields that are present", () => {
    const result = ToolCapabilitiesPatchSchema.parse({ allowedSecrets: ["API_KEY"] });
    expect(result).toEqual({ allowedSecrets: ["API_KEY"] });
  });
});

describe("asStringArray", () => {
  it("passes through a string array", () => {
    expect(asStringArray(["a", "b"])).toEqual(["a", "b"]);
  });
  it("drops non-string elements", () => {
    expect(asStringArray(["a", 1, null, "b"])).toEqual(["a", "b"]);
  });
  it("returns [] for null, undefined, objects, and non-array Json", () => {
    expect(asStringArray(null)).toEqual([]);
    expect(asStringArray(undefined)).toEqual([]);
    expect(asStringArray({})).toEqual([]);
    expect(asStringArray("not-an-array")).toEqual([]);
  });
});

describe("allowedSharedDatastorePrefixes", () => {
  it("defaults to {} when omitted from a full ToolCapabilitiesSchema parse", () => {
    const result = ToolCapabilitiesSchema.parse({});
    expect(result.allowedSharedDatastorePrefixes).toEqual({});
  });

  it("accepts a map of boundName to prefix list", () => {
    const result = ToolCapabilitiesSchema.parse({ allowedSharedDatastorePrefixes: { kb: ["docs:", "faq:"] } });
    expect(result.allowedSharedDatastorePrefixes).toEqual({ kb: ["docs:", "faq:"] });
  });

  it("rejects more than MAX_ALLOWED_SHARED_DATASTORES bound names", () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: MAX_ALLOWED_SHARED_DATASTORES + 1 }, (_, i) => [`kb${i}`, [""]]),
    );
    expect(() => ToolCapabilitiesSchema.parse({ allowedSharedDatastorePrefixes: tooMany })).toThrow();
  });

  it("ToolCapabilitiesPatchSchema leaves it optional (undefined when omitted)", () => {
    const result = ToolCapabilitiesPatchSchema.parse({});
    expect(result.allowedSharedDatastorePrefixes).toBeUndefined();
  });
});

describe("asPrefixMap", () => {
  it("coerces a plain object of string arrays", () => {
    expect(asPrefixMap({ kb: ["a:", "b:"] })).toEqual({ kb: ["a:", "b:"] });
  });

  it("degrades foreign/malformed data to {} rather than throwing", () => {
    expect(asPrefixMap(null)).toEqual({});
    expect(asPrefixMap("not an object")).toEqual({});
    expect(asPrefixMap({ kb: "not an array" })).toEqual({ kb: [] });
    expect(asPrefixMap({ kb: [1, "a:", null] })).toEqual({ kb: ["a:"] });
  });
});
