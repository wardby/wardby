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
  it("accepts exactly 20 hosts, hostnames with digits, and an all-digit label before the last", () => {
    const hosts = Array.from({ length: 20 }, (_, i) => `h${i}.example.com`);
    expect(parseSecretBrokerConfig({ hosts, placement: header }).hosts).toHaveLength(20);
    expect(
      parseSecretBrokerConfig({ hosts: ["123.example.com", "s3.us-east-1.amazonaws.com"], placement: header }).hosts,
    ).toEqual(["123.example.com", "s3.us-east-1.amazonaws.com"]);
  });
  it("lowercases hosts and keeps path prefixes", () => {
    const c = parseSecretBrokerConfig({ hosts: ["API.Example.com"], pathPrefixes: ["/v1/"], placement: header });
    expect(c).toEqual({ hosts: ["api.example.com"], pathPrefixes: ["/v1/"], placement: header });
  });
  it.each<[unknown]>([
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
    // IPv4 shorthand a resolver would read as an address, and a label ending in "-".
    [{ hosts: ["127.1"], placement: header }],
    [{ hosts: ["10.0.1"], placement: header }],
    [{ hosts: ["0x7f.0.0.1"], placement: header }],
    [{ hosts: ["foo.0x7f"], placement: header }],
    [{ hosts: ["foo-.example.com"], placement: header }],
    [{ hosts: ["example-.com"], placement: header }],
    // Path prefixes with query, fragment, backslash, control characters, or encoded separators.
    ...["/v1?x", "/v1#x", "/v1\\x", "/v1\nx", "/v1\u0000x", "/v1\u007fx", "/a%2fb", "/a%2Fb", "/a%5cb", "/a%5Cb"].map(
      (prefix): [unknown] => [{ hosts: ["example.com"], pathPrefixes: [prefix], placement: header }],
    ),
    // Unknown keys on any placement.
    [{ hosts: ["example.com"], placement: { ...header, extra: 1 } }],
    [{ hosts: ["example.com"], placement: { kind: "query", name: "k", extra: 1 } }],
    [{ hosts: ["example.com"], placement: { kind: "body", field: "f", extra: 1 } }],
    [{ hosts: ["example.com"], placement: { kind: "aws-sigv4", region: "us-east-1", service: "s3", extra: 1 } }],
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
