import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { TOOLCHAIN_DOCKER_SOURCE } from "../providers/jobs/storage-init.js";

const read = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");

describe("docker CLI in the images that run the agent's shell", () => {
  it.each(["../claude-tool-runner/Dockerfile", "../coding-worker/Dockerfile.driver"])(
    "%s copies the docker CLI and compose plugin from a digest-pinned CLI image of the daemon's major version",
    async (path) => {
      const dockerfile = await read(path);
      const daemon = (await read("./Dockerfile")).match(/^FROM docker:(\d+\.\d+\.\d+)-dind-rootless@/m);
      expect(dockerfile).toMatch(/^FROM docker:29\.\d+\.\d+-cli@sha256:[0-9a-f]{64} AS docker-cli$/m);
      expect(daemon?.[1]?.split(".")[0]).toBe("29");
      expect(dockerfile).toContain("COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker");
      expect(dockerfile).toContain("/usr/local/libexec/docker/cli-plugins/docker-compose");
    },
  );

  it("the Claude Code agent image carries them off its PATH, where storage-init copies them into a toolchain", async () => {
    const dockerfile = await read("../claude-coding-worker/Dockerfile");
    expect(dockerfile).toMatch(/^FROM docker:29\.\d+\.\d+-cli@sha256:[0-9a-f]{64} AS docker-cli$/m);
    expect(dockerfile).toContain(`COPY --from=docker-cli /usr/local/bin/docker ${TOOLCHAIN_DOCKER_SOURCE}/docker`);
    expect(dockerfile).toContain(
      `COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose ${TOOLCHAIN_DOCKER_SOURCE}/cli-plugins/docker-compose`,
    );
    // The agent never runs commands: no docker on its PATH.
    expect(dockerfile).not.toContain("/usr/local/bin/docker /usr/local/bin/docker");
    expect(dockerfile).toContain("test ! -e /usr/bin/docker");
  });

  it("every image pins the same CLI release", async () => {
    const pins = await Promise.all(
      [
        "../claude-tool-runner/Dockerfile",
        "../coding-worker/Dockerfile.driver",
        "../claude-coding-worker/Dockerfile",
      ].map(
        async (path) => (await read(path)).match(/^FROM (docker:[^ ]+-cli@sha256:[0-9a-f]{64}) AS docker-cli$/m)?.[1],
      ),
    );
    expect(new Set(pins).size).toBe(1);
    expect(pins[0]).toBeDefined();
  });
});
