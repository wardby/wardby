import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const tag = "reevo-coding-worker:phase5-smoke";

await execFile("docker", ["build", "--quiet", "--file", "src/coding-worker/Dockerfile", "--tag", tag, "."], {
  maxBuffer: 1024 * 1024,
});
const { stdout } = await execFile("docker", ["image", "inspect", "--format", "{{.Id}}", tag], {
  maxBuffer: 1024 * 1024,
});
process.stdout.write(`${stdout.trim()}\n`);
