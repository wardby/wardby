import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { modulesMissingFromImage, relativeImportClosure } from "../coding-worker/image-closure.test-support.js";

describe("Claude coding worker image policy", () => {
  it("pins every stage, contains no workspace, and excludes privileged host tooling", async () => {
    const dockerfile = await readFile(new URL("./Dockerfile", import.meta.url), "utf8");
    const from = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));
    expect(from.length).toBeGreaterThan(1);
    expect(from.every((line) => /@sha256:[0-9a-f]{64}/.test(line))).toBe(true);
    expect(dockerfile).not.toContain("COPY src/claude-tool-runner");
    expect(dockerfile).not.toContain("COPY --from=build /build/.git");
    expect(dockerfile).toContain("/build/dist/coding-worker/keeper.js");
    // The shared debug tracer and the registry-token derivation it redacts with.
    expect(dockerfile).toContain("/build/dist/coding-worker/debug-trace.js");
    expect(dockerfile).toContain("/build/dist/coding/registry/token.js");
    // tool-socket.js reads the dependency cache module's timeouts.
    expect(dockerfile).toContain("COPY src/coding-worker/dependency-cache.mjs ./coding-worker/dependency-cache.mjs");
    expect(dockerfile).toContain("/worker/node_modules ./node_modules");
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain('ENTRYPOINT ["node"');
    for (const executable of ["docker", "ssh", "curl", "wget", "sudo", "gcc", "make", "git"]) {
      expect(dockerfile).toContain(`test ! -e /usr/bin/${executable}`);
    }
  });

  it("copies every module the worker's entry points import", async () => {
    const dockerfile = await readFile(new URL("./Dockerfile", import.meta.url), "utf8");
    const closure = relativeImportClosure([
      "claude-coding-worker/main.ts",
      "claude-coding-worker/tool-relay.ts",
      "coding-worker/keeper.ts",
    ]);
    expect(closure).toContain("coding/redact.ts");
    expect(modulesMissingFromImage(dockerfile, closure)).toEqual([]);
    // The build imports main.js's dependencies, so a missing COPY fails the build.
    for (const module of [
      "claude-coding-worker/driver",
      "claude-coding-worker/transcript",
      "coding-worker/debug-trace",
    ]) {
      expect(dockerfile).toContain(`"${module}"`);
    }
  });
});
