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

  it("splices an array element on remove instead of leaving a null hole", () => {
    expect(applyMutations({ list: ["a", "b", "c"] }, [{ op: "remove", path: "/list/1" }])).toEqual({
      list: ["a", "c"],
    });
    // A hole would survive JSON as `null`, which a pod comparison would read as a list entry.
    expect(JSON.stringify(applyMutations({ list: ["a", "b"] }, [{ op: "remove", path: "/list/0" }]))).toBe(
      '{"list":["b"]}',
    );
  });

  it("refuses an array remove whose index is out of range or not an index", () => {
    for (const path of ["/list/2", "/list/-1", "/list/01", "/list/name"]) {
      expect(() => applyMutations({ list: ["a", "b"] }, [{ op: "remove", path }])).toThrow("dry_run_fixture_path");
    }
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

  it("orders paths by code point, so the committed file does not depend on the capturing machine's locale", () => {
    const paths = diffMutations({}, { b: 1, A: 1, a: 1, B: 1, "-": 1 }).map((mutation) => mutation.path);
    expect(paths).toEqual(["/-", "/A", "/B", "/a", "/b"]);
    // The locale-aware collation this deliberately avoids folds case together instead.
    expect([...paths].sort((x, y) => x.localeCompare(y))).not.toEqual(paths);
  });

  // Regression measured on a real cluster: a captured pod's arrays (containers, volumes,
  // hostAliases) come back from a real API server with nested objects in different KEY ORDER
  // than buildRunPod's own literals (e.g. resources.requests as {cpu, ephemeral-storage, memory}
  // instead of {cpu, memory, ephemeral-storage}) even when every value is identical. A raw
  // `JSON.stringify` compare on the whole array treats that as a change and replaces the entire
  // array with an opaque blob — exactly the failure mode this function's own doc comment warns a
  // genuine platform rewrite could hide inside.
  it("does not flag an array as changed when only nested key order differs", () => {
    const before = { spec: { containers: [{ resources: { cpu: "1", memory: "2", ["ephemeral-storage"]: "3" } }] } };
    const after = { spec: { containers: [{ resources: { ["ephemeral-storage"]: "3", cpu: "1", memory: "2" } }] } };
    expect(diffMutations(before, after)).toEqual([]);
  });

  it("still flags an array as changed when a value inside it actually differs", () => {
    const before = { spec: { containers: [{ resources: { cpu: "1" } }] } };
    const after = { spec: { containers: [{ resources: { cpu: "2" } }] } };
    expect(diffMutations(before, after)).toEqual([
      { op: "replace", path: "/spec/containers", value: after.spec.containers },
    ]);
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
