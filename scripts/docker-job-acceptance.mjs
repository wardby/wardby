import { execFileSync, spawnSync } from "node:child_process";

const requestedImage = process.env.WARDBY_WORKER_IMAGE ?? "wardby-coding-worker:phase5-smoke";
try {
  execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", requestedImage], {
    encoding: "utf8",
  }).trim();
} catch {
  process.stderr.write(`Worker image not found: ${requestedImage}\n`);
  process.exit(1);
}

const fixtureTag = `wardby-docker-job-fixture-${process.pid}`;
const fixtureSource = [
  `FROM ${requestedImage}`,
  "USER root",
  "COPY scripts/docker-job-keeper-fixture.js /opt/wardby/coding-worker/keeper.js",
  "USER 10001:10001",
  "ENTRYPOINT [\"node\", \"-e\", \"require('node:fs').writeFileSync('/run/wardby/output/result.json', JSON.stringify({schemaVersion:1,runId:'docker-smoke',outcome:'no_changes',summary:'fixture',tests:[]})); setTimeout(() => process.exit(0), 500)\"]",
].join("\n");
const built = spawnSync("docker", ["build", "--quiet", "--tag", fixtureTag, "--file", "-", "."], {
  cwd: new URL("..", import.meta.url),
  input: fixtureSource,
  encoding: "utf8",
});
if (built.status !== 0) {
  process.stderr.write(built.stderr || "Unable to build Docker job fixture image.\n");
  process.exit(built.status ?? 1);
}

const fixtureImage = execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", fixtureTag], {
  encoding: "utf8",
}).trim();
const vitest = new URL("../node_modules/vitest/vitest.mjs", import.meta.url);
const result = spawnSync(process.execPath, [vitest.pathname, "run", "src/providers/jobs/docker.integration.test.ts"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, WARDBY_DOCKER_JOB_TEST: "1", WARDBY_DOCKER_JOB_FIXTURE_IMAGE: fixtureImage },
  stdio: "inherit",
});
spawnSync("docker", ["image", "rm", "--force", fixtureTag], { stdio: "ignore" });
process.exit(result.status ?? 1);
