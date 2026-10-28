import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { modulesMissingFromImage, relativeImportClosure } from "./image-closure.test-support.js";

describe("coding worker image policy", () => {
  it("Dockerfile.driver pins every stage and installs only language-agnostic base tooling", async () => {
    const dockerfile = await readFile(new URL("./Dockerfile.driver", import.meta.url), "utf8");
    const from = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));
    expect(from.length).toBeGreaterThan(1);
    expect(from.every((line) => /@sha256:[0-9a-f]{64}/.test(line))).toBe(true);
    expect(dockerfile).toContain("--no-install-recommends ca-certificates git");
    expect(dockerfile).toContain("npm ci --omit=dev");
    expect(dockerfile).toContain("npm install --global --omit=dev npm@12.0.2");
    // The driver is an intermediate layer other Dockerfiles build on top of —
    // it must not set USER/ENTRYPOINT itself (those depend on whatever
    // language toolchain and hardening checks the derived Dockerfile adds).
    expect(dockerfile).not.toContain("USER 10001:10001");
    expect(dockerfile).not.toContain("ENTRYPOINT");
    // The npm shim (lockfile verification before an install) is on the
    // agent's PATH, login shells included, and runs the real npm.
    expect(dockerfile).toContain("COPY src/coding-worker/npm-shim.mjs ./bin/npm-shim.mjs");
    expect(dockerfile).toContain("ln -s npm-shim.mjs /opt/wardby/bin/npm");
    // The same shim acts as pnpm and yarn (lockfile plans for theirs too).
    expect(dockerfile).toContain("ln -s npm-shim.mjs /opt/wardby/bin/pnpm");
    expect(dockerfile).toContain("ln -s npm-shim.mjs /opt/wardby/bin/yarn");
    expect(dockerfile).toContain("test \"$(bash -lc 'command -v yarn')\" = /opt/wardby/bin/yarn");
    expect(dockerfile).toContain("/etc/profile.d/wardby-shims.sh");
    // The dependency cache module, next to driver.js, which imports it on a run that asks for it;
    // the build fails, not the run, when it is missing.
    expect(dockerfile).toContain("COPY src/coding-worker/dependency-cache.mjs ./coding-worker/dependency-cache.mjs");
    expect(dockerfile).toContain("/opt/wardby/coding-worker/dependency-cache.mjs");
  });

  it("Dockerfile pins its FROM to the driver by digest and excludes privileged or general-purpose host tooling", async () => {
    const dockerfile = await readFile(new URL("./Dockerfile", import.meta.url), "utf8");
    const from = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));
    expect(from.length).toBe(1);
    expect(from[0]).toMatch(/wardby-coding-worker-driver@sha256:[0-9a-f]{64}/);
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain('ENTRYPOINT ["node"');
    for (const executable of ["docker", "ssh", "curl", "wget", "sudo", "gcc", "make"]) {
      expect(dockerfile).toContain(`test ! -e /usr/bin/${executable}`);
    }
  });

  it("Dockerfile.node-python pins its FROM to the driver by digest and excludes privileged or general-purpose host tooling", async () => {
    const dockerfile = await readFile(new URL("./Dockerfile.node-python", import.meta.url), "utf8");
    const from = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));
    expect(from.length).toBe(1);
    expect(from[0]).toMatch(/wardby-coding-worker-driver@sha256:[0-9a-f]{64}/);
    expect(dockerfile).toContain("--no-install-recommends python3 python3-pip");
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain('ENTRYPOINT ["node"');
    for (const executable of ["docker", "ssh", "curl", "wget", "sudo", "gcc", "make", "pip", "pip3"]) {
      expect(dockerfile).toContain(`test ! -e /usr/bin/${executable}`);
    }
  });

  it("Dockerfile.driver copies every module the driver's entry point imports", async () => {
    const dockerfile = await readFile(new URL("./Dockerfile.driver", import.meta.url), "utf8");
    const closure = relativeImportClosure(["coding-worker/main.ts"]);
    expect(closure).toContain("coding/redact.ts");
    expect(modulesMissingFromImage(dockerfile, closure)).toEqual([]);
    expect(dockerfile).toContain('"debug-trace"');
  });
});
