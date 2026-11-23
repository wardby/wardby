import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { CODING_WORKER_UID } from "../providers/jobs/docker-isolation.js";

const read = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");

describe("docker service image policy", () => {
  it("builds on a digest-pinned upstream rootless dind image of the documented major version", async () => {
    const dockerfile = await read("./Dockerfile");
    const from = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));
    expect(from).toHaveLength(1);
    expect(from[0]).toMatch(/^FROM docker:29\.\d+\.\d+-dind-rootless@sha256:[0-9a-f]{64}$/);
  });

  it("adds the run's user and a subordinate id range for it, and runs as that user", async () => {
    const dockerfile = await read("./Dockerfile");
    const uid = String(CODING_WORKER_UID);
    expect(dockerfile).toContain(`'wardby:x:${uid}:${uid}:wardby:/home/wardby:/bin/sh' >> /etc/passwd`);
    expect(dockerfile).toContain(`'wardby:x:${uid}:' >> /etc/group`);
    expect(dockerfile).toContain("'wardby:100000:65536' >> /etc/subuid");
    expect(dockerfile).toContain("'wardby:100000:65536' >> /etc/subgid");
    expect(dockerfile.trimEnd().split("\n").at(-1)).toBe(`USER ${uid}:${uid}`);
  });

  it("leaves the daemon's arguments to wardby: no entrypoint, command or exposed port of its own", async () => {
    const dockerfile = await read("./Dockerfile");
    expect(dockerfile).not.toMatch(/^(ENTRYPOINT|CMD|EXPOSE|ENV DOCKER_HOST)\b/m);
  });
});
