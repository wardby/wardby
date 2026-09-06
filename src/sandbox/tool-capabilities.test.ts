import { describe, expect, it } from "vitest";
import {
  ToolCapabilitiesSchema,
  ToolCapabilitiesPatchSchema,
  asStringArray,
  FETCH_WILDCARD,
  MAX_ALLOWED_HOSTS,
} from "./tool-capabilities.js";

describe("ToolCapabilitiesSchema", () => {
  it("defaults every field to an empty (deny-all) array", () => {
    const result = ToolCapabilitiesSchema.parse({});
    expect(result).toEqual({ allowedSecrets: [], allowedDatastorePrefixes: [], allowedHosts: [] });
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
