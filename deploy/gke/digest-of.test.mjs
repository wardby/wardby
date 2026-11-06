// Runs up.sh's digest_of under bash with a fake docker whose image carries a
// digest in two registries, the other one listed first: digest_of must return
// the one in REGISTRY, and stop the deploy when REGISTRY has none.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = readFileSync(fileURLToPath(new URL("./up.sh", import.meta.url)), "utf8");
const start = "# --- digest_of ---";
const end = "# --- end digest_of ---";
const section = script.slice(script.indexOf(start), script.indexOf(end) + end.length);

const REGISTRY = "us-central1-docker.pkg.dev/example-project/wardby";
const OTHER = "123456789012.dkr.ecr.us-east-1.amazonaws.com/wardby";
const HERE = `${REGISTRY}/coding-worker@sha256:${"a".repeat(64)}`;
const THERE = `${OTHER}/coding-worker@sha256:${"b".repeat(64)}`;

/** A docker that answers `inspect` with these RepoDigests, one per line. */
function fakeDocker(digests) {
  const dir = mkdtempSync(join(tmpdir(), "digest-of-"));
  const docker = join(dir, "docker");
  writeFileSync(docker, `#!/bin/sh\nprintf '%s\\n' ${digests.map((d) => `'${d}'`).join(" ")}\n`);
  chmodSync(docker, 0o755);
  return dir;
}

const run = (digests) =>
  spawnSync("bash", ["-c", `set -euo pipefail\n${section}\nX="$(digest_of coding-worker)"\nprintf '%s' "$X"`], {
    env: { PATH: `${fakeDocker(digests)}:${process.env.PATH}`, REGISTRY },
    encoding: "utf8",
  });

describe("deploy/gke/up.sh digest_of", () => {
  it("has the section, and every image digest goes through it", () => {
    expect(section).toContain("digest_of()");
    expect(script).not.toContain("RepoDigests 0");
    expect(script).toContain('WORKER_IMAGE="$(digest_of coding-worker)"');
  });

  it("returns the digest in REGISTRY when another registry's is listed first", () => {
    const result = run([THERE, HERE]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(HERE);
  });

  it("matches REGISTRY only at the start, not inside another host's path", () => {
    const lookalike = `other.example/${HERE}`;
    const result = run([lookalike, THERE, HERE]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(HERE);
  });

  it("stops the deploy when the image has no digest in REGISTRY", () => {
    const result = run([THERE]);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`${REGISTRY}/coding-worker:latest has no digest in ${REGISTRY}`);
  });
});
