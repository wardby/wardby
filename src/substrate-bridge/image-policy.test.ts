import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// The release workflow builds these on the just-pushed worker and tool-runner images by digest
// (`--build-arg BASE=<repo>@sha256:...`), so the Dockerfiles must take their base only from BASE.
describe.each([
  { file: "Dockerfile.agent", entrypoint: "/opt/wardby/substrate-bridge/agent.js" },
  { file: "Dockerfile.tool", entrypoint: "/opt/wardby/substrate-bridge/tool.js" },
])("Substrate bridge image policy: $file", ({ file, entrypoint }) => {
  it("builds only on a required BASE, runs as non-root and carries no secrets", async () => {
    const dockerfile = await readFile(new URL(`./${file}`, import.meta.url), "utf8");
    const lines = dockerfile.split("\n").map((line) => line.trim());
    const from = lines.filter((line) => /^FROM\s/i.test(line));
    // One stage, on BASE alone: no tag-pinned or unpinned image can slip in beside it.
    expect(from).toEqual(["FROM ${BASE}"]);
    // BASE has no default, so a build without a digest-pinned base fails instead of picking one.
    expect(lines.filter((line) => /^ARG\s+BASE\b/.test(line))).toEqual(["ARG BASE"]);
    // The last USER is the worker's non-root user, so the bridge never runs as root.
    const users = lines.filter((line) => /^USER\s/.test(line));
    expect(users.at(-1)).toBe("USER 10001:10001");
    expect(lines.indexOf("USER 10001:10001")).toBeLessThan(lines.findIndex((line) => line.startsWith("ENTRYPOINT")));
    expect(dockerfile).toContain(`ENTRYPOINT ["node", "${entrypoint}"]`);
    // No credential is baked in: no ENV at all, and no key or token names.
    expect(lines.some((line) => /^ENV\s/i.test(line))).toBe(false);
    expect(dockerfile).not.toMatch(/API_KEY|TOKEN|SECRET|PASSWORD|CAPABILITY/i);
    // Only the built bridge is added on top of the base.
    expect(lines.filter((line) => /^(COPY|ADD)\s/i.test(line))).toEqual([
      "COPY dist/substrate-bridge/ /opt/wardby/substrate-bridge/",
    ]);
  });
});
