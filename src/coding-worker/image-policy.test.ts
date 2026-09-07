import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("coding worker image policy", () => {
  it("pins every stage and excludes privileged or general-purpose host tooling", async () => {
    const dockerfile = await readFile(new URL("./Dockerfile", import.meta.url), "utf8");
    const from = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));
    expect(from.length).toBeGreaterThan(1);
    expect(from.every((line) => /@sha256:[0-9a-f]{64}/.test(line))).toBe(true);
    expect(dockerfile).toContain("--no-install-recommends ca-certificates git");
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain('ENTRYPOINT ["node"');
    for (const executable of ["docker", "ssh", "curl", "wget", "sudo", "gcc", "make"]) {
      expect(dockerfile).toContain(`test ! -e /usr/bin/${executable}`);
    }
  });
});
