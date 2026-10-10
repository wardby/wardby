import { describe, expect, it } from "vitest";
import { assertBrokerableValue, parseSecretBrokerConfig, parseSigV4Value } from "./secret-broker-config.js";

const header = { kind: "header", name: "Authorization", format: "Bearer {value}" } as const;

describe("parseSecretBrokerConfig", () => {
  it("accepts each placement kind", () => {
    for (const placement of [
      header,
      { kind: "query", name: "key" },
      { kind: "body", field: "api_key" },
      { kind: "aws-sigv4", region: "us-east-1", service: "s3" },
    ]) {
      expect(parseSecretBrokerConfig({ hosts: ["api.example.com"], placement }).placement).toEqual(placement);
    }
  });
  it("lowercases hosts and keeps path prefixes", () => {
    const c = parseSecretBrokerConfig({ hosts: ["API.Example.com"], pathPrefixes: ["/v1/"], placement: header });
    expect(c).toEqual({ hosts: ["api.example.com"], pathPrefixes: ["/v1/"], placement: header });
  });
  it.each([
    [{ hosts: [], placement: header }],
    [{ hosts: ["*.example.com"], placement: header }],
    [{ hosts: ["example.com:8443"], placement: header }],
    [{ hosts: ["10.0.0.1"], placement: header }],
    [{ hosts: ["[::1]"], placement: header }],
    [{ hosts: ["https://example.com"], placement: header }],
    [{ hosts: Array.from({ length: 21 }, (_, i) => `h${i}.example.com`), placement: header }],
    [{ hosts: ["example.com"], pathPrefixes: ["v1/"], placement: header }],
    [{ hosts: ["example.com"], placement: { kind: "header", name: "Host", format: "{value}" } }],
    [{ hosts: ["example.com"], placement: { kind: "header", name: "Bad Name", format: "{value}" } }],
    [{ hosts: ["example.com"], placement: { kind: "header", name: "X-Key", format: "no placeholder" } }],
    [{ hosts: ["example.com"], placement: { kind: "header", name: "X-Key", format: "{value}{value}" } }],
    [{ hosts: ["example.com"], placement: { kind: "header", name: "X-Key", format: "{value}\r\nX: y" } }],
    [{ hosts: ["example.com"], placement: { kind: "query", name: "" } }],
    [{ hosts: ["example.com"], placement: { kind: "nope" } }],
  ])("rejects %j", (input) => {
    expect(() => parseSecretBrokerConfig(input)).toThrow(/^secret_broker_config_invalid: /);
  });
});

describe("values", () => {
  it("parses a SigV4 value", () => {
    expect(parseSigV4Value('{"accessKeyId":"AKIDEXAMPLE","secretAccessKey":"wJalrXUtnFEMIK7MDENG"}')).toEqual({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMIK7MDENG",
    });
    expect(() => parseSigV4Value("not json")).toThrow("secret_broker_value_invalid");
    expect(() => parseSigV4Value('{"accessKeyId":"A"}')).toThrow("secret_broker_value_invalid");
  });
  it("refuses values too short to scrub", () => {
    const c = parseSecretBrokerConfig({ hosts: ["example.com"], placement: header });
    expect(() => assertBrokerableValue(c, "abc")).toThrow("secret_broker_value_invalid");
    expect(() => assertBrokerableValue(c, "abcdef")).not.toThrow();
  });
  it("checks the SigV4 shape and secret key length", () => {
    const c = parseSecretBrokerConfig({
      hosts: ["example.com"],
      placement: { kind: "aws-sigv4", region: "us-east-1", service: "s3" },
    });
    expect(() => assertBrokerableValue(c, "plain")).toThrow("secret_broker_value_invalid");
    expect(() => assertBrokerableValue(c, '{"accessKeyId":"AKID","secretAccessKey":"short"}')).toThrow(
      "secret_broker_value_invalid",
    );
  });
});
