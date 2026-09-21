import { execFileSync, spawnSync } from "node:child_process";

function imageId(name, label) {
  try {
    return execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", name], { encoding: "utf8" }).trim();
  } catch {
    process.stderr.write(`${label} image not found: ${name}\n`);
    process.exit(1);
  }
}

const agent = imageId(process.env.WARDBY_CLAUDE_WORKER_IMAGE ?? "wardby-claude-coding-worker:phase5", "Claude worker");
const tool = imageId(
  process.env.WARDBY_CLAUDE_TOOL_RUNNER_IMAGE ?? "wardby-claude-tool-runner:phase5",
  "Claude tool runner",
);
const vitest = new URL("../node_modules/vitest/vitest.mjs", import.meta.url);
const result = spawnSync(
  process.execPath,
  [vitest.pathname, "run", "src/providers/jobs/docker-claude.integration.test.ts"],
  {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      WARDBY_CLAUDE_DOCKER_TEST: "1",
      WARDBY_CLAUDE_WORKER_IMAGE: agent,
      WARDBY_CLAUDE_TOOL_RUNNER_IMAGE: tool,
    },
    stdio: "inherit",
  },
);
process.exit(result.status ?? 1);
