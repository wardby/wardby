import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setupAgentScript, storageInitScript, toolchainAgentScript, toolchainDockerScript } from "./storage-init.js";

/** Runs a storage-init script the way the pod does (`node -e`), against a temporary storage root. */
function runScript(script: string): void {
  const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
}

describe("toolchainAgentScript (#599)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function setup() {
    const root = mkdtempSync(join(tmpdir(), "wardby-storage-"));
    roots.push(root);
    const source = join(root, "source-wardby-cmd");
    writeFileSync(source, "#!/bin/sh\necho agent\n");
    const script = [
      storageInitScript(root, ["workspace", "input", "output", "cmd"]),
      toolchainAgentScript(root, source),
    ];
    return { root, source, script: script.join("\n") };
  }

  it("copies the agent into storage/cmd and writes a 32-byte run token only the run uid can read", () => {
    const { root, source, script } = setup();
    runScript(script);
    expect(readFileSync(join(root, "cmd", "wardby-cmd"), "utf8")).toBe(readFileSync(source, "utf8"));
    expect(statSync(join(root, "cmd", "wardby-cmd")).mode & 0o777).toBe(0o500);
    const token = readFileSync(join(root, "cmd", "token"), "utf8");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(join(root, "cmd", "token")).mode & 0o777).toBe(0o400);
    expect(statSync(join(root, "cmd")).mode & 0o777).toBe(0o700);
  });

  it("keeps the token across a storage-init restart (the toolchain read it when it started)", () => {
    const { root, script } = setup();
    runScript(script);
    const first = readFileSync(join(root, "cmd", "token"), "utf8");
    runScript(script);
    expect(readFileSync(join(root, "cmd", "token"), "utf8")).toBe(first);
  });

  it("gives every run a different token", () => {
    const one = setup();
    const two = setup();
    runScript(one.script);
    runScript(two.script);
    expect(readFileSync(join(one.root, "cmd", "token"), "utf8")).not.toBe(
      readFileSync(join(two.root, "cmd", "token"), "utf8"),
    );
  });

  it("never prints the token", () => {
    const { script } = setup();
    const result = spawnSync(process.execPath, ["-e", script], { encoding: "utf8" });
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});

describe("toolchainDockerScript", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function setup() {
    const root = mkdtempSync(join(tmpdir(), "wardby-storage-"));
    roots.push(root);
    const agent = join(root, "source-wardby-cmd");
    writeFileSync(agent, "#!/bin/sh\necho agent\n");
    const docker = join(root, "source-docker");
    mkdirSync(join(docker, "cli-plugins"), { recursive: true });
    writeFileSync(join(docker, "docker"), "docker-cli");
    writeFileSync(join(docker, "cli-plugins", "docker-compose"), "compose-plugin");
    const script = [
      storageInitScript(root, ["workspace", "input", "output", "cmd"]),
      toolchainAgentScript(root, agent),
      toolchainDockerScript(root, docker),
    ].join("\n");
    return { root, script };
  }

  it("copies the docker CLI and compose plugin into storage/cmd/docker, executable by the run uid only", () => {
    const { root, script } = setup();
    runScript(script);
    expect(readFileSync(join(root, "cmd", "docker", "docker"), "utf8")).toBe("docker-cli");
    expect(readFileSync(join(root, "cmd", "docker", "cli-plugins", "docker-compose"), "utf8")).toBe("compose-plugin");
    expect(statSync(join(root, "cmd", "docker", "docker")).mode & 0o777).toBe(0o500);
    expect(statSync(join(root, "cmd", "docker", "cli-plugins", "docker-compose")).mode & 0o777).toBe(0o500);
    expect(statSync(join(root, "cmd", "docker")).mode & 0o777).toBe(0o700);
  });

  it("survives a storage-init restart and prints nothing", () => {
    const { root, script } = setup();
    runScript(script);
    runScript(script);
    expect(readFileSync(join(root, "cmd", "docker", "docker"), "utf8")).toBe("docker-cli");
  });
});

describe("setupAgentScript (#589)", () => {
  it("copies the agent alone into cmd-bin and never writes a token", () => {
    const root = mkdtempSync(join(tmpdir(), "wardby-storage-"));
    try {
      const source = join(root, "source-wardby-cmd");
      writeFileSync(source, "#!/bin/sh\necho agent\n");
      runScript([storageInitScript(root, ["cmd-bin"]), setupAgentScript(root, source)].join("\n"));
      expect(readFileSync(join(root, "cmd-bin", "wardby-cmd"), "utf8")).toBe(readFileSync(source, "utf8"));
      expect(statSync(join(root, "cmd-bin", "wardby-cmd")).mode & 0o777).toBe(0o500);
      expect(() => statSync(join(root, "cmd-bin", "token"))).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
