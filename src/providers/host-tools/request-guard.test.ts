import { describe, expect, it } from "vitest";
import { assertHostToolHeaders, assertHostToolRequest, HostToolRequestDenied } from "./request-guard.js";

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
    "/2.0/repositories/acme/web/pullrequests?method=x&q=_method",
    ...[
      "src/abc/a%20b.txt",
      "src/abc/100%25.txt",
      "src/abc/100%.txt",
      "src/abc/50%25off.txt",
      "src/abc/.hidden",
      "src/abc/a..b",
      "diff/acme/web:abc%0Ddef",
    ].map((rest) => `/2.0/repositories/acme/web/${rest}`),
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
    ["a _method override", url("/2.0/repositories/acme/web?_method=DELETE")],
    ["a _METHOD override", url("/2.0/repositories/acme/web?a=1&_METHOD=DELETE")],
    ["an encoded _method override", url("/2.0/repositories/acme/web?%5Fmethod=DELETE")],
    ["an x-http-method query key", url("/2.0/repositories/acme/web?x-http-method=DELETE")],
    ["an X-HTTP-Method-Override query key", url("/2.0/repositories/acme/web?X-HTTP-Method-Override=DELETE")],
    ["not a URL", "nope"],
    ["a parameter dot-segment", url("/2.0/repositories/acme/web/..;/other")],
    ["a parameter dot-segment with text", url("/2.0/repositories/acme/web/..;x/..;y/z")],
    ["an encoded dot-segment with a parameter", url("/2.0/repositories/acme/web/%2e%2e;/other")],
    ["a double-encoded dot-segment", url("/2.0/repositories/acme/web/%252e%252e/other")],
    ["a double-encoded slash", url("/2.0/repositories/acme/web/..%252fother")],
    ["an encoded NUL", url("/2.0/repositories/acme/web/..%00/other")],
    ["encoded form ..%20/other", url("/2.0/repositories/acme/web/..%20/other")],
    ["encoded form .%20./other", url("/2.0/repositories/acme/web/.%20./other")],
    ["encoded form %20../other", url("/2.0/repositories/acme/web/%20../other")],
    ["encoded form ..%2520/other", url("/2.0/repositories/acme/web/..%2520/other")],
    ["encoded form ..%c2%a0/other", url("/2.0/repositories/acme/web/..%c2%a0/other")],
    ["encoded form ..%e3%80%80/other", url("/2.0/repositories/acme/web/..%e3%80%80/other")],
    ["encoded form ..%c2%85/other", url("/2.0/repositories/acme/web/..%c2%85/other")],
    ["encoded form .%c2%ad./other", url("/2.0/repositories/acme/web/.%c2%ad./other")],
    ["encoded form ..%e2%80%8b/other", url("/2.0/repositories/acme/web/..%e2%80%8b/other")],
    ["encoded form .%e2%80%8b./other", url("/2.0/repositories/acme/web/.%e2%80%8b./other")],
    ["encoded form ..%ef%bb%bf/other", url("/2.0/repositories/acme/web/..%ef%bb%bf/other")],
    ["encoded form %EF%BC%8E%EF%BC%8E/other", url("/2.0/repositories/acme/web/%EF%BC%8E%EF%BC%8E/other")],
    ["encoded form ．．/other", url("/2.0/repositories/acme/web/．．/other")],
    ["encoded form ..%EF%BC%8Fother", url("/2.0/repositories/acme/web/..%EF%BC%8Fother")],
    [
      "encoded form %EF%BC%8E%EF%BC%8E%EF%BC%8Fother",
      url("/2.0/repositories/acme/web/%EF%BC%8E%EF%BC%8E%EF%BC%8Fother"),
    ],
    ["encoded form ..%EF%BC%BCother", url("/2.0/repositories/acme/web/..%EF%BC%BCother")],
    ["encoded form ..%E2%88%95other", url("/2.0/repositories/acme/web/..%E2%88%95other")],
    ["encoded form ..%E2%81%84other", url("/2.0/repositories/acme/web/..%E2%81%84other")],
    ["encoded form ..%3f/other", url("/2.0/repositories/acme/web/..%3f/other")],
    ["encoded form ..%23/other", url("/2.0/repositories/acme/web/..%23/other")],
    ["encoded form ..%253f/other", url("/2.0/repositories/acme/web/..%253f/other")],
    ["encoded form ..%2523/other", url("/2.0/repositories/acme/web/..%2523/other")],
    ["encoded form ...", url("/2.0/repositories/acme/web/...")],
    ["encoded form ..%2e/other", url("/2.0/repositories/acme/web/..%2e/other")],
    ["encoded form ..,x/other", url("/2.0/repositories/acme/web/..,x/other")],
    ["encoded form ..:x/other", url("/2.0/repositories/acme/web/..:x/other")],
    ["encoded form %252e%252e%25/other", url("/2.0/repositories/acme/web/%252e%252e%25/other")],
    ["a repository name with a parameter", url("/2.0/repositories/acme/web;x/y")],
    ["a repository name with an encoded semicolon", url("/2.0/repositories/acme/web%3Bx/y")],
    ["parameters on earlier segments", url("/2.0;x/repositories/acme;y/web/z")],
    ["a fullwidth repository name", url("/2.0/repositories/acme/%EF%BD%97%EF%BD%85%EF%BD%82/x")],
    ["a leading BOM in the repository name", url("/2.0/repositories/acme/%EF%BB%BFweb/x")],
    ["a trailing BOM in the repository name", url("/2.0/repositories/acme/web%EF%BB%BF/x")],
    ["a fullwidth percent dot-segment", url("/2.0/repositories/acme/web/％2e％2e/other")],
    [
      "an encoded fullwidth percent dot-segment",
      url("/2.0/repositories/acme/web/%EF%BC%85%32%65%EF%BC%85%32%65/other"),
    ],
  ])("refuses %s", (_label, target) => {
    expect(() => assertHostToolRequest(target, "GET", scope)).toThrow(HostToolRequestDenied);
  });

  it("allows a repository under an encoded prefix", () => {
    const encoded = { ...scope, pathPrefix: "/2.0/repositories/acme/my%20repo" };
    expect(() => assertHostToolRequest(url("/2.0/repositories/acme/my%20repo/src/a"), "GET", encoded)).not.toThrow();
  });

  it("refuses a method the operation doesn't use", () => {
    expect(() => assertHostToolRequest(url("/2.0/repositories/acme/web"), "POST", scope)).toThrow(
      HostToolRequestDenied,
    );
    expect(() => assertHostToolRequest(url("/2.0/repositories/acme/web"), "get", scope)).not.toThrow();
  });

  it("refuses a pathPrefix that would allow every path", () => {
    for (const pathPrefix of ["", "x"]) {
      expect(() => assertHostToolRequest(url("/a"), "GET", { ...scope, pathPrefix })).toThrow(HostToolRequestDenied);
    }
  });

  it("allows only plain content headers", () => {
    expect(() => assertHostToolHeaders(undefined)).not.toThrow();
    expect(() =>
      assertHostToolHeaders({ Accept: "a", "If-None-Match": "x", "content-type": "t", "if-match": "y" }),
    ).not.toThrow();
    for (const bad of [
      { "X-HTTP-Method-Override": "DELETE" },
      { "X-Original-URL": "/x" },
      { Authorization: "x" },
      ["accept"],
      "accept",
      null,
    ]) {
      expect(() => assertHostToolHeaders(bad)).toThrow(HostToolRequestDenied);
    }
  });
});
