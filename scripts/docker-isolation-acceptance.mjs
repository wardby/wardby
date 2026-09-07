import { execFileSync, spawnSync } from "node:child_process";

const requestedImage = process.env.REEVO_WORKER_IMAGE ?? "reevo-coding-worker:task8";
let image;
try {
  image = execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", requestedImage], {
    encoding: "utf8",
  }).trim();
} catch {
  process.stderr.write(`Worker image not found: ${requestedImage}\n`);
  process.exit(1);
}

const vitest = new URL("../node_modules/vitest/vitest.mjs", import.meta.url);
const result = spawnSync(
  process.execPath,
  [vitest.pathname, "run", "src/providers/jobs/docker-isolation.integration.test.ts"],
  {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      REEVO_DOCKER_ISOLATION_TEST: "1",
      REEVO_WORKER_IMAGE: image,
    },
    stdio: "inherit",
  },
);
process.exit(result.status ?? 1);
