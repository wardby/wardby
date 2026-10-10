import { describe, expect, it } from "vitest";
import {
  applyBrokerPlacements,
  brokerScrubValues,
  checkBrokerDestination,
  scrubBrokeredResponse,
  type BrokeredSecret,
} from "./secret-broker.js";

const gh: BrokeredSecret = {
  name: "GH",
  value: "ghp_secretvalue",
  broker: {
    hosts: ["api.github.com"],
    pathPrefixes: ["/repos/"],
    placement: { kind: "header", name: "Authorization", format: "Bearer {value}" },
  },
};
const q: BrokeredSecret = {
  name: "Q",
  value: "qkey-123456",
  broker: { hosts: ["maps.example.com"], placement: { kind: "query", name: "key" } },
};
const b: BrokeredSecret = {
  name: "B",
  value: "bkey-123456",
  broker: { hosts: ["api.example.com"], placement: { kind: "body", field: "api_key" } },
};

describe("checkBrokerDestination", () => {
  it("allows an https URL on an allowed host and path", () => {
    expect(() => checkBrokerDestination("https://api.github.com/repos/o/r", [gh])).not.toThrow();
  });
  it.each([
    "http://api.github.com/repos/o/r",
    "https://evil.example/repos/o/r",
    "https://api.github.com/gists",
    "https://api.github.com.evil.example/repos/",
    "https://API.GITHUB.COM:444/repos/o/r",
  ])("denies %s", (url) => {
    expect(() => checkBrokerDestination(url, [gh])).toThrow(/^secret_broker_destination_denied/);
  });
  it("requires every named secret to allow the destination", () => {
    expect(() => checkBrokerDestination("https://api.github.com/repos/o/r", [gh, q])).toThrow(
      /^secret_broker_destination_denied/,
    );
  });
});

describe("applyBrokerPlacements", () => {
  it("places a header", () => {
    const out = applyBrokerPlacements(
      { url: "https://api.github.com/repos/o/r", method: "GET", headers: { Accept: "x" } },
      [gh],
    );
    expect(out.headers).toEqual({ accept: "x", authorization: "Bearer ghp_secretvalue" });
  });
  it("places a query parameter", () => {
    const out = applyBrokerPlacements({ url: "https://maps.example.com/v1?a=1", method: "GET", headers: {} }, [q]);
    expect(out.url).toBe("https://maps.example.com/v1?a=1&key=qkey-123456");
  });
  it("places a JSON body field", () => {
    const out = applyBrokerPlacements(
      {
        url: "https://api.example.com/x",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: '{"q":1}',
      },
      [b],
    );
    expect(JSON.parse(out.body!)).toEqual({ q: 1, api_key: "bkey-123456" });
  });
  it("places a form body field", () => {
    const out = applyBrokerPlacements(
      {
        url: "https://api.example.com/x",
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "q=1",
      },
      [b],
    );
    expect(new URLSearchParams(out.body).get("api_key")).toBe("bkey-123456");
  });
  it.each([
    [
      { url: "https://api.github.com/repos/o/r", method: "GET", headers: { authorization: "x" } },
      gh,
      "secret_broker_conflict",
    ],
    [{ url: "https://maps.example.com/v1?key=x", method: "GET", headers: {} }, q, "secret_broker_conflict"],
    [
      {
        url: "https://api.example.com/x",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: '{"api_key":1}',
      },
      b,
      "secret_broker_conflict",
    ],
    [
      {
        url: "https://api.example.com/x",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "[1]",
      },
      b,
      "secret_broker_body_invalid",
    ],
    [
      { url: "https://api.example.com/x", method: "POST", headers: { "content-type": "text/plain" }, body: "hi" },
      b,
      "secret_broker_body_invalid",
    ],
    [{ url: "https://api.example.com/x", method: "GET", headers: {} }, b, "secret_broker_body_invalid"],
  ])("rejects %j", (request, secret, code) => {
    expect(() => applyBrokerPlacements(request, [secret])).toThrow(new RegExp(`^${code}`));
  });
  it("rejects two secrets placing the same header", () => {
    expect(() =>
      applyBrokerPlacements({ url: "https://api.github.com/repos/o/r", method: "GET", headers: {} }, [
        gh,
        { ...gh, name: "GH2" },
      ]),
    ).toThrow(/^secret_broker_conflict/);
  });
});

describe("scrubBrokeredResponse", () => {
  const secret = "ghp_secretvalue";
  const encode = (s: string) => Buffer.from(s).toString("base64");
  it("scrubs raw, base64, base64url, and percent-encoded forms from headers, body, and url", () => {
    const body = [
      secret,
      Buffer.from(secret).toString("base64"),
      Buffer.from(secret).toString("base64url"),
      encodeURIComponent("a/" + secret + "/b"),
    ].join(" ");
    const out = scrubBrokeredResponse(
      { url: `https://x/?t=${secret}`, headers: { "x-echo": `Bearer ${secret}` }, bodyBase64: encode(body), ok: true },
      [secret],
    );
    const text = Buffer.from(out.bodyBase64, "base64").toString("utf8");
    expect(text).not.toContain(secret);
    expect(text).not.toContain(Buffer.from(secret).toString("base64"));
    expect(out.headers["x-echo"]).toBe("Bearer [REDACTED]");
    expect(out.url).not.toContain(secret);
    expect(out.ok).toBe(true);
  });
  it("scrubs encoded forms of a value with reserved characters", () => {
    // Reserved characters make encodeURIComponent, base64, and base64url forms differ from the raw value.
    const reserved = "ghp_secret/value+1=";
    const rb = Buffer.from(reserved, "utf8");
    const body = [reserved, encodeURIComponent(reserved), rb.toString("base64"), rb.toString("base64url")].join(" ");
    expect(encodeURIComponent(reserved)).not.toBe(reserved);
    expect(rb.toString("base64url")).not.toBe(rb.toString("base64"));
    const out = scrubBrokeredResponse({ url: "https://x/", headers: {}, bodyBase64: encode(body), ok: true }, [
      reserved,
    ]);
    const text = Buffer.from(out.bodyBase64, "base64").toString("utf8");
    expect(text).toBe(["[REDACTED]", "[REDACTED]", "[REDACTED]", "[REDACTED]"].join(" "));
    expect(text).not.toContain(encodeURIComponent(reserved));
    expect(text).not.toContain(rb.toString("base64"));
    expect(text).not.toContain(rb.toString("base64url"));
  });
  it("scrubs a query-placed value containing ~ ! and space in every encoding the response may echo", () => {
    // URLSearchParams encodes ~ and ! and space (as +) differently from encodeURIComponent.
    const value = "abc8Q~xyz!def ghi";
    const qs: BrokeredSecret = {
      name: "Q2",
      value,
      broker: { hosts: ["maps.example.com"], placement: { kind: "query", name: "k" } },
    };
    const placed = applyBrokerPlacements({ url: "https://maps.example.com/v1?a=1", method: "GET", headers: {} }, [qs]);
    const sentUrl = placed.url;
    expect(sentUrl).toContain("k=abc8Q%7Exyz%21def+ghi");
    // Echo the placed URL and a lowercase-hex variant of its query in both the URL and the body.
    const lowerQuery = "k=abc8Q%7exyz%21def+ghi";
    const out = scrubBrokeredResponse(
      {
        url: `${sentUrl}&echo=${lowerQuery}`,
        headers: {},
        bodyBase64: Buffer.from(`${sentUrl} ${lowerQuery} ${value}`).toString("base64"),
        ok: true,
      },
      brokerScrubValues([qs]),
    );
    const text = Buffer.from(out.bodyBase64, "base64").toString("utf8");
    expect(out.url).not.toMatch(/abc8Q|xyz|def|ghi/);
    expect(text).not.toMatch(/abc8Q|xyz|def|ghi/);
    expect(text).toBe("https://maps.example.com/v1?a=1&k=[REDACTED] k=[REDACTED] [REDACTED]");
  });
  it("places a header value containing $ patterns verbatim", () => {
    const dollar: BrokeredSecret = {
      name: "D",
      value: "pa$$wo$'rd99",
      broker: { hosts: ["api.github.com"], placement: { kind: "header", name: "X-Secret", format: "Bearer {value}" } },
    };
    const out = applyBrokerPlacements({ url: "https://api.github.com/x", method: "GET", headers: {} }, [dollar]);
    expect(out.headers["x-secret"]).toBe("Bearer pa$$wo$'rd99");
  });
  it("lists SigV4 secret key and session token as scrub values", () => {
    const sig: BrokeredSecret = {
      name: "AWS",
      value: '{"accessKeyId":"AKID","secretAccessKey":"secretkey123","sessionToken":"tok-123456"}',
      broker: { hosts: ["s3.amazonaws.com"], placement: { kind: "aws-sigv4", region: "us-east-1", service: "s3" } },
    };
    expect(brokerScrubValues([sig]).sort()).toEqual(["secretkey123", "tok-123456"]);
  });
});
