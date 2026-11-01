import { describe, expect, it } from "vitest";
import { assertHostToolRequest, HostToolRequestDenied } from "./request-guard.js";

const scope = {
  apiHosts: ["api.example.com"],
  pathPrefix: "/2.0/repositories/acme/web",
  methods: ["GET"],
};
const url = (path: string) => `https://api.example.com${path}`;

describe("assertHostToolRequest", () => {
  it.each([
    "/2.0/repositories/acme/web",
    "/2.0/repositories/acme/web/pullrequests/4",
    "/2.0/repositories/ACME/Web/src/abc/a.txt?x=1",
  ])("allows %s", (path) => {
    expect(() => assertHostToolRequest(url(path), "GET", scope)).not.toThrow();
  });

  it.each([
    ["another repository", url("/2.0/repositories/acme/other")],
    ["a sibling sharing the prefix", url("/2.0/repositories/acme/web2/pullrequests")],
    ["a dot-segment escape", url("/2.0/repositories/acme/web/../other")],
    ["an encoded dot-segment escape", url("/2.0/repositories/acme/web/%2e%2e/other")],
    ["an encoded slash", url("/2.0/repositories/acme/web%2f..%2fother")],
    ["an encoded backslash", url("/2.0/repositories/acme/web/%5c..%5cother")],
    ["a backslash", url("/2.0/repositories/acme/web\\..\\other")],
    ["another host", "https://evil.example.com/2.0/repositories/acme/web"],
    ["plain http", "http://api.example.com/2.0/repositories/acme/web"],
    ["another port", "https://api.example.com:8443/2.0/repositories/acme/web"],
    ["user info", "https://u:p@api.example.com/2.0/repositories/acme/web"],
    ["not a URL", "nope"],
  ])("refuses %s", (_label, target) => {
    expect(() => assertHostToolRequest(target, "GET", scope)).toThrow(HostToolRequestDenied);
  });

  it("refuses a method the operation doesn't use", () => {
    expect(() => assertHostToolRequest(url("/2.0/repositories/acme/web"), "POST", scope)).toThrow(
      HostToolRequestDenied,
    );
    expect(() => assertHostToolRequest(url("/2.0/repositories/acme/web"), "get", scope)).not.toThrow();
  });
});
