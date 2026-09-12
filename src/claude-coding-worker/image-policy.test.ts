import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Claude coding worker image policy", () => {
  it("pins every stage, contains no workspace, and excludes privileged host tooling", async () => {
    const dockerfile = await readFile(new URL("./Dockerfile", import.meta.url), "utf8");
    const from = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));
    expect(from.length).toBeGreaterThan(1);
    expect(from.every((line) => /@sha256:[0-9a-f]{64}/.test(line))).toBe(true);
    expect(dockerfile).not.toContain("COPY src/claude-tool-runner");
    expect(dockerfile).not.toContain("COPY --from=build /build/.git");
    expect(dockerfile).toContain("/build/dist/coding-worker/keeper.js");
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain('ENTRYPOINT ["node"');
    for (const executable of ["docker", "ssh", "curl", "wget", "sudo", "gcc", "make", "git"]) {
      expect(dockerfile).toContain(`test ! -e /usr/bin/${executable}`);
    }
  });
});
