import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const dockerfile = process.argv[2] ?? "src/coding-worker/Dockerfile";
const tag = process.argv[3] ?? "reevo-coding-worker:phase5-smoke";

await execFile("docker", ["build", "--quiet", "--file", dockerfile, "--tag", tag, "."], {
  maxBuffer: 1024 * 1024,
});
const { stdout } = await execFile("docker", ["image", "inspect", "--format", "{{.Id}}", tag], {
  maxBuffer: 1024 * 1024,
});
process.stdout.write(`${stdout.trim()}\n`);
