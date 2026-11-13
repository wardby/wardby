import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("Claude tool runner image policy", () => {
  it("pins every stage and contains neither agent runtime nor network client tooling", async () => {
    const dockerfile = await readFile(new URL("./Dockerfile", import.meta.url), "utf8");
    const lockfile = await readFile(new URL("./package-lock.json", import.meta.url), "utf8");
    const from = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));
    const stages = new Set(from.map((line) => line.split(/\s+/)[3]).filter(Boolean));
    expect(from.length).toBeGreaterThan(1);
    // Every external base is digest-pinned; a later stage may build on an earlier one by name.
    expect(from.every((line) => /@sha256:[0-9a-f]{64}/.test(line) || stages.has(line.split(/\s+/)[1]))).toBe(true);
    expect(dockerfile).not.toContain("claude-agent-sdk");
    expect(dockerfile).not.toContain("ANTHROPIC_API_KEY");
    expect(lockfile).not.toContain("@anthropic-ai/");
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain("COPY src/coding-worker/npm-shim.mjs /opt/wardby/bin/npm-shim.mjs");
    // The same shim acts as pnpm and yarn (lockfile plans for theirs too).
    expect(dockerfile).toContain("ln -s npm-shim.mjs /opt/wardby/bin/pnpm");
    expect(dockerfile).toContain("ln -s npm-shim.mjs /opt/wardby/bin/yarn");
    expect(dockerfile).toContain("/etc/profile.d/wardby-shims.sh");
    // main.mjs imports ../coding-worker/dependency-cache.mjs on a dependency-cache run.
    expect(dockerfile).toContain(
      "COPY src/coding-worker/dependency-cache.mjs /opt/wardby/coding-worker/dependency-cache.mjs",
    );
    expect(dockerfile.match(/AS runtime/g)).toHaveLength(1);
  });

  it("has git for history runs (#536): the tool runner is the only Claude Code container that may", async () => {
    const dockerfile = await readFile(new URL("./Dockerfile", import.meta.url), "utf8");
    const base = dockerfile.slice(dockerfile.indexOf(" AS base"), dockerfile.indexOf(" AS node-python"));
    const python = dockerfile.slice(dockerfile.indexOf(" AS node-python"), dockerfile.lastIndexOf("FROM "));
    expect(base).toContain("apt-get install -y --no-install-recommends git");
    expect(dockerfile).not.toContain("test ! -e /usr/bin/git");
    // Every target checks that git runs, and still that ssh (a git recommendation) is absent.
    for (const stage of [base, python]) {
      expect(stage).toContain("git --version");
      expect(stage).toContain("test ! -e /usr/bin/ssh");
    }
    // main.mjs imports ../coding-worker/result-bundle.mjs for the git tools.
    expect(dockerfile).toContain(
      "COPY src/coding-worker/result-bundle.mjs /opt/wardby/coding-worker/result-bundle.mjs",
    );
    expect(dockerfile).toContain('import("/opt/wardby/coding-worker/result-bundle.mjs")');
  });

  it("builds the node-python tool runner as a named target, keeping the plain one the default", async () => {
    const dockerfile = await readFile(new URL("./Dockerfile", import.meta.url), "utf8");
    const from = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));
    // `docker build` with no --target builds the last stage: the plain Node tool runner.
    expect(from.at(-1)).toMatch(/ AS runtime$/);
    const python = dockerfile.slice(dockerfile.indexOf(" AS node-python"), dockerfile.lastIndexOf("FROM "));
    expect(python).toContain("python3-venv");
    expect(python).toContain("pytest==8.3.4");
    expect(python).toContain("ruff==0.16.7");
    expect(python).toContain("ln -s /usr/bin/python3 /usr/bin/python");
    for (const absent of ["/usr/bin/pip", "/usr/bin/pip3", "/usr/bin/gcc", "/usr/bin/curl"]) {
      expect(python).toContain(`test ! -e ${absent}`);
    }
    expect(python).toContain("USER 10001:10001");
  });
});
