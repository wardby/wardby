import { describe, expect, it } from "vitest";
import { applyMutations, diffMutations, loadDryRunFixture } from "./kubernetes-dry-run-fixture.js";

describe("applyMutations", () => {
  it("adds, replaces and removes by JSON Pointer, unescaping ~1 and ~0", () => {
    const document = { metadata: { annotations: { keep: "1", drop: "2" } }, spec: { containers: [{ name: "a" }] } };
    expect(
      applyMutations(document, [
        { op: "add", path: "/metadata/annotations/autopilot.gke.io~1warden-version", value: "v1" },
        { op: "replace", path: "/spec/containers/0/name", value: "b" },
        { op: "remove", path: "/metadata/annotations/drop" },
      ]),
    ).toEqual({
      metadata: { annotations: { keep: "1", "autopilot.gke.io/warden-version": "v1" } },
      spec: { containers: [{ name: "b" }] },
    });
  });

  it("does not mutate its input", () => {
    const document = { a: 1 };
    applyMutations(document, [{ op: "replace", path: "/a", value: 2 }]);
    expect(document).toEqual({ a: 1 });
  });

  it("throws on a path that does not resolve", () => {
    expect(() => applyMutations({ a: 1 }, [{ op: "replace", path: "/b/c", value: 2 }])).toThrow("dry_run_fixture_path");
  });
});

describe("diffMutations", () => {
  it("round-trips: applying the diff to `before` reproduces `after`", () => {
    const before = { metadata: { annotations: { keep: "1" } }, spec: { tolerations: undefined as unknown } };
    const after = {
      metadata: { annotations: { keep: "1", "autopilot.gke.io/x": "y" } },
      spec: { tolerations: [{ key: "k" }] },
    };
    const mutations = diffMutations(before, after);
    expect(applyMutations(before, mutations)).toEqual(after);
  });
});

describe("loadDryRunFixture", () => {
  it("loads the committed Autopilot capture", () => {
    const fixture = loadDryRunFixture();
    expect(fixture.platform).toBe("gke-autopilot");
    expect(fixture.mutations.length).toBeGreaterThan(0);
    expect(typeof fixture.provisional).toBe("boolean");
  });
});
