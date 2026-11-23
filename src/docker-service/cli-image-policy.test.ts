import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

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
});
