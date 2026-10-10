import { execFileSync, spawnSync } from "node:child_process";

function imageId(name, label) {
  try {
    return execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", name], { encoding: "utf8" }).trim();
  } catch {
    process.stderr.write(`${label} image not found: ${name}. Build the images with: npm run claude:images:local\n`);
    process.exit(1);
  }
}

const agent = imageId(process.env.WARDBY_CLAUDE_WORKER_IMAGE ?? "wardby-claude-coding-worker:phase5", "Claude worker");
const tool = imageId(
  process.env.WARDBY_CLAUDE_TOOL_RUNNER_IMAGE ?? "wardby-claude-tool-runner:phase5",
  "Claude tool runner",
);
// A tool runner built FROM the release one, as operators do (src/claude-tool-runner/Dockerfile.custom-example).
const customTool = imageId(
  process.env.WARDBY_CLAUDE_CUSTOM_TOOL_RUNNER_IMAGE ?? "wardby-claude-tool-runner-custom:phase5",
  "Custom Claude tool runner",
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
      WARDBY_CLAUDE_CUSTOM_TOOL_RUNNER_IMAGE: customTool,
    },
    stdio: "inherit",
  },
);
process.exit(result.status ?? 1);
