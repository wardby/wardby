import { describe, expect, it } from "vitest";
import { signSigV4 } from "./secret-broker-sigv4.js";
import type { BrokeredSecret } from "./secret-broker.js";

const secret: BrokeredSecret = {
  name: "AWS",
  value: JSON.stringify({
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  }),
  broker: {
    hosts: ["example.amazonaws.com"],
    placement: { kind: "aws-sigv4", region: "us-east-1", service: "service" },
  },
};

describe("signSigV4", () => {
  it("matches the AWS SigV4 test suite get-vanilla signature", async () => {
    const out = await signSigV4(
      { url: "https://example.amazonaws.com/", method: "GET", headers: {} },
      secret,
      new Date("2015-08-30T12:36:00Z"),
    );
    expect(out.headers["x-amz-date"]).toBe("20150830T123600Z");
    expect(out.headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
    expect(out.headers.host).toBeUndefined();
  });

  it("adds the session token header", async () => {
    const withToken = {
      ...secret,
      value: JSON.stringify({
        accessKeyId: "AKID",
        secretAccessKey: "secretkey123",
        sessionToken: "tok-123456",
      }),
    };
    const out = await signSigV4({ url: "https://example.amazonaws.com/", method: "GET", headers: {} }, withToken);
    expect(out.headers["x-amz-security-token"]).toBe("tok-123456");
  });

  it("signs repeated query keys", async () => {
    const out = await signSigV4(
      { url: "https://example.amazonaws.com/?a=1&a=2&b=3", method: "GET", headers: {} },
      secret,
      new Date("2015-08-30T12:36:00Z"),
    );
    const single = await signSigV4(
      { url: "https://example.amazonaws.com/?a=1&b=3", method: "GET", headers: {} },
      secret,
      new Date("2015-08-30T12:36:00Z"),
    );
    expect(out.headers.authorization).not.toBe(single.headers.authorization);
  });

  it("adds x-amz-content-sha256 for s3 only", async () => {
    const s3 = {
      ...secret,
      broker: {
        ...secret.broker,
        placement: { kind: "aws-sigv4" as const, region: "us-east-1", service: "s3" },
      },
    };
    const req = { url: "https://example.amazonaws.com/k", method: "PUT", headers: {}, body: "hi" };
    expect((await signSigV4(req, s3)).headers["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect((await signSigV4(req, secret)).headers["x-amz-content-sha256"]).toBeUndefined();
  });

  it("does not leak the secret key in errors", async () => {
    const bad = { ...secret, value: "not json wJalrXUtnFEMI" };
    await expect(
      signSigV4({ url: "https://example.amazonaws.com/", method: "GET", headers: {} }, bad),
    ).rejects.not.toThrow(/wJalrXUtnFEMI/);
  });

  it.each(["Authorization", "X-Amz-Date", "x-amz-security-token", "x-amz-content-sha256"])(
    "refuses a tool-set %s header",
    async (h) => {
      await expect(
        signSigV4({ url: "https://example.amazonaws.com/", method: "GET", headers: { [h]: "x" } }, secret),
      ).rejects.toThrow(/^secret_broker_conflict/);
    },
  );
});
