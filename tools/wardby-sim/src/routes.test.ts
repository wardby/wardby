import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { routeKey, ROUTES } from "./routes.js";
import { allRouteDefs } from "./services.js";

const ROOT = resolve(import.meta.dirname, "../../..");

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === ".terraform" || name === "node_modules") return [];
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe("wardby-sim route table", () => {
  it("lists exactly the routes the services register, each with a verified status", () => {
    const registered = allRouteDefs().map(routeKey).sort();
    const listed = ROUTES.map(routeKey).sort();
    expect(listed).toEqual(registered);
    expect(new Set(listed).size).toBe(listed.length);
    for (const route of ROUTES) {
      expect(typeof route.verified).toBe("boolean");
      if (route.verified) expect(route.recording).toBeTruthy();
      expect(route.note.length).toBeGreaterThan(0);
    }
  });
});

describe("wardby-sim stays test-only", () => {
  it("is not in the published npm package", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { files: string[] };
    expect(pkg.files.filter((entry) => entry.startsWith("tools"))).toEqual([]);
  });

  it("is referenced by nothing under deploy/gke or deploy/aws", () => {
    for (const target of ["deploy/gke", "deploy/aws"]) {
      for (const file of filesUnder(join(ROOT, target))) {
        const content = readFileSync(file, "utf8");
        expect(content.includes("wardby-sim") || content.includes("WARDBY_TEST_SIMULATORS"), file).toBe(false);
      }
    }
  });
});
