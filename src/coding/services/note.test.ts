import { describe, expect, it } from "vitest";
import { DOCKER_SERVICE_NOTE, servicesInstructionNote } from "./note.js";

describe("servicesInstructionNote", () => {
  it("says nothing for a run without services", () => {
    expect(servicesInstructionNote([])).toBeUndefined();
  });

  it("lists each service and its variables, says they start empty and where they are", () => {
    const note = servicesInstructionNote([
      {
        name: "postgres",
        version: "16",
        testEnv: { DATABASE_URL: "postgres://test:test@127.0.0.1:5432/test", PGHOST: "127.0.0.1" },
      },
      { name: "redis", version: "7", testEnv: {} },
    ]);
    expect(note).toBe(
      [
        "Services for this run: wardby started these next to your workspace, reachable on 127.0.0.1. Each one starts empty; create any schema or data your tests need.",
        "- postgres 16: DATABASE_URL=postgres://test:test@127.0.0.1:5432/test, PGHOST=127.0.0.1",
        "- redis 7",
        "These variables are already set in your shell environment; tests should read them instead of hard-coding connection details. Where two services set the same variable, the one listed first wins.",
      ].join("\n"),
    );
  });

  it("leaves a sidecar-only note exactly as before when entries carry their kind", () => {
    const entries = [{ name: "redis", version: "7", testEnv: {}, kind: "sidecar" as const }];
    expect(servicesInstructionNote(entries)).toBe(
      servicesInstructionNote([{ name: "redis", version: "7", testEnv: {} }]),
    );
  });

  it("says the commands run in the toolchain, never that it is a service on 127.0.0.1", () => {
    const note = servicesInstructionNote([{ name: "python-dev", version: "3.13", testEnv: {}, kind: "toolchain" }]);
    expect(note).toBe(
      "Toolchain for this run: wardby runs your shell commands on this workspace in the `python-dev 3.13` image, with its own interpreters, packages and settings. Use what it already has rather than installing another interpreter or rewriting its configuration.",
    );
  });

  it("names the toolchain's variables, then the services", () => {
    const note = servicesInstructionNote([
      { name: "python-dev", version: "3.13", testEnv: { APP_ENV: "test" }, kind: "toolchain" },
      { name: "redis", version: "7", testEnv: {}, kind: "sidecar" },
    ])!;
    const lines = note.split("\n");
    expect(lines[0]).toMatch(/^Toolchain for this run: .* It sets: APP_ENV=test\.$/);
    expect(lines[1]).toMatch(/^Services for this run:/);
    expect(lines[2]).toBe("- redis 7");
    expect(lines[3]).toMatch(/^These variables are already set/);
    expect(lines).toHaveLength(4);
  });

  it("names the setup jobs as already run, never as services reachable on 127.0.0.1 (#589)", () => {
    const note = servicesInstructionNote([
      {
        name: "mysql",
        version: "8",
        testEnv: { DATABASE_URL: "mysql://test:test@127.0.0.1:3306/test" },
        kind: "sidecar",
      },
      { name: "app-migrations", version: "1", testEnv: {}, kind: "setup" },
      { name: "search-mappings", version: "2", testEnv: {}, kind: "setup" },
    ])!;
    expect(note.split("\n")).toEqual([
      "Services for this run: wardby started these next to your workspace, reachable on 127.0.0.1. Each one starts empty apart from what the setup jobs below did; create any other schema or data your tests need.",
      "- mysql 8: DATABASE_URL=mysql://test:test@127.0.0.1:3306/test",
      "Setup jobs for this run: before you started, wardby ran `app-migrations 1`, `search-mappings 2` against these services, in that order, and each succeeded.",
      "These variables are already set in your shell environment; tests should read them instead of hard-coding connection details. Where two services set the same variable, the one listed first wins.",
    ]);
    expect(note).not.toContain("- app-migrations");
  });

  it("adds DOCKER_HOST and how to use the daemon only for a run with a docker service", () => {
    const note = servicesInstructionNote([
      { name: "redis", version: "7", testEnv: {} },
      { kind: "docker", name: "docker", version: "29" },
    ])!;
    expect(note).toContain("- docker 29: DOCKER_HOST=unix:///wardby/docker/docker.sock");
    expect(note.endsWith(DOCKER_SERVICE_NOTE)).toBe(true);
    for (const rule of [
      "--network=host",
      "network_mode: host",
      "127.0.0.1",
      "HTTPS proxy",
      "Docker Hub",
      "--build-arg HTTPS_PROXY",
    ]) {
      expect(DOCKER_SERVICE_NOTE).toContain(rule);
    }
    expect(servicesInstructionNote([{ name: "redis", version: "7", testEnv: {} }])).not.toContain("Docker");
  });

  it("with a toolchain, lists the docker service under the run's services and still says how to use it", () => {
    const lines = servicesInstructionNote([
      { name: "python-dev", version: "3.13", testEnv: {}, kind: "toolchain" },
      { kind: "docker", name: "docker", version: "29" },
    ])!.split("\n");
    expect(lines[0]).toMatch(/^Toolchain for this run:/);
    expect(lines[1]).toMatch(/^Services for this run:/);
    expect(lines[2]).toBe("- docker 29: DOCKER_HOST=unix:///wardby/docker/docker.sock");
    expect(lines[3]).toMatch(/^These variables are already set/);
    expect(lines[4]).toBe(DOCKER_SERVICE_NOTE);
    expect(lines).toHaveLength(5);
  });
});
