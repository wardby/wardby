import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// The release workflow builds these on the just-pushed worker and tool-runner images by digest
// (`--build-arg BASE=<repo>@sha256:...`), so the Dockerfiles must take their base only from BASE.
describe.each([
  { file: "Dockerfile.agent", entrypoint: "/opt/wardby/substrate-bridge/agent.js" },
  { file: "Dockerfile.tool", entrypoint: "/opt/wardby/substrate-bridge/tool.js" },
  { file: "Dockerfile.codex", entrypoint: "/opt/wardby/substrate-bridge/codex.js" },
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

it("adds no package manager, downloader or remote shell on top of the Codex worker image", async () => {
  const dockerfile = await readFile(new URL("./Dockerfile.codex", import.meta.url), "utf8");
  const commands = dockerfile
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  for (const word of ["apt-get", "apt", "apk", "curl", "wget", "ssh", "npm", "pip"]) {
    expect(commands.some((line) => new RegExp(`\\b${word}\\b`).test(line))).toBe(false);
  }
});

// Operators copy these to add the Substrate bridge to their own custom image (workerImageRef): both
// bases come in by digest, the bridge comes only from the release's bridge image, and the launcher
// sets the command, so the example has no ENTRYPOINT or CMD of its own.
describe.each([
  { file: "Dockerfile.custom-tool-example", base: "TOOL_RUNNER_IMAGE", tool: true },
  { file: "Dockerfile.custom-codex-example", base: "WORKER_IMAGE", tool: false },
])("Substrate custom image example: $file", ({ file, base, tool }) => {
  it("builds on digest-pinned bases, adds only the bridge, runs as non-root and sets no command", async () => {
    const dockerfile = await readFile(new URL(`./${file}`, import.meta.url), "utf8");
    const lines = dockerfile.split("\n").map((line) => line.trim());
    // Both build arguments are required: no default, so a build without digests fails.
    expect(lines.filter((line) => /^ARG\s/i.test(line))).toEqual([`ARG ${base}`, "ARG BRIDGE_IMAGE"]);
    // The bridge as a named stage (a FROM line always expands a build argument; COPY --from may not).
    expect(lines.filter((line) => /^FROM\s/i.test(line))).toEqual([
      "FROM ${BRIDGE_IMAGE} AS bridge",
      `FROM \${${base}}`,
    ]);
    const users = lines.filter((line) => /^USER\s/i.test(line));
    expect(users.at(-1)).toBe("USER 10001:10001");
    expect(lines.some((line) => /^(ENTRYPOINT|CMD)\b/i.test(line))).toBe(false);
    expect(lines.some((line) => /^ENV\s/i.test(line))).toBe(false);
    expect(dockerfile).not.toMatch(/API_KEY|TOKEN|SECRET|PASSWORD|CAPABILITY/i);
    expect(lines.filter((line) => /^(COPY|ADD)\s/i.test(line))).toEqual([
      "COPY --from=bridge /opt/wardby/substrate-bridge/ /opt/wardby/substrate-bridge/",
    ]);
    const dirs = ["/run/wardby/input", "/run/wardby/output", "/workspace", ...(tool ? ["/run/wardby/tool"] : [])];
    const mkdir = lines.find((line) => /^RUN mkdir -p\s/.test(line));
    expect(mkdir, "a RUN mkdir -p line").toBeDefined();
    for (const dir of dirs) expect(mkdir?.split(/\s+/), dir).toContain(dir);
  });
});
