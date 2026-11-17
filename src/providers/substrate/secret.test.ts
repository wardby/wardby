import { describe, expect, it } from "vitest";
import { credentialUri, substrateSecret } from "./secret.js";

describe("credentialUri", () => {
  it("names one key of a per-run Secret", () => {
    expect(credentialUri("wardby-run-credentials", "wr-00000000000000000000", "capability")).toBe(
      "ate-secret://k8s.io/default/wardby-run-credentials/wr-00000000000000000000/capability",
    );
  });
});

describe("substrateSecret", () => {
  it("has the one shape a per-run Secret takes", () => {
    expect(
      substrateSecret({
        name: "wr-1",
        namespace: "ns",
        label: { key: "wardby.dev/substrate-run", value: "wr-1" },
        data: { capability: "cap" },
      }),
    ).toEqual({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "wr-1", namespace: "ns", labels: { "wardby.dev/substrate-run": "wr-1" } },
      stringData: { capability: "cap" },
    });
  });
});
