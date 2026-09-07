import { execFileSync, spawnSync } from "node:child_process";

const requestedImage = process.env.REEVO_WORKER_IMAGE ?? "reevo-coding-worker:task9";
try {
  execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", requestedImage], {
    encoding: "utf8",
  }).trim();
} catch {
  process.stderr.write(`Worker image not found: ${requestedImage}\n`);
  process.exit(1);
}

const fixtureTag = `reevo-docker-job-fixture-${process.pid}`;
const fixtureSource = [
  `FROM ${requestedImage}`,
  "USER root",
  "COPY scripts/docker-job-keeper-fixture.js /opt/reevo/coding-worker/keeper.js",
  "USER 10001:10001",
  "ENTRYPOINT [\"node\", \"-e\", \"require('node:fs').writeFileSync('/run/reevo/output/result.json', JSON.stringify({schemaVersion:1,runId:'docker-smoke',outcome:'no_changes',summary:'fixture',tests:[]})); setTimeout(() => process.exit(0), 500)\"]",
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
  env: { ...process.env, REEVO_DOCKER_JOB_TEST: "1", REEVO_DOCKER_JOB_FIXTURE_IMAGE: fixtureImage },
  stdio: "inherit",
});
spawnSync("docker", ["image", "rm", "--force", fixtureTag], { stdio: "ignore" });
process.exit(result.status ?? 1);
