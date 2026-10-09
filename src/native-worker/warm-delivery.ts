/**
 * How a claimed warm worker gets its input (native sandbox phase 6): the launcher runs this fixed
 * command inside the worker's container (`docker exec -i`, or the Kubernetes exec API) with the
 * WorkerInput on stdin. The capability is never in the command, so it stays out of argv, the
 * environment, and Kubernetes audit logs. The file is written under a temporary name and hard-linked into
 * place (a link, unlike a rename, never replaces an existing file), so the waiting worker never
 * reads half of it, and a second delivery to one worker fails.
 */

/** Where a pool worker waits for its input: /tmp is its only writable filesystem. */
export const WARM_INPUT_DIR = "/tmp/wardby-input";
export const WARM_INPUT_FILE = `${WARM_INPUT_DIR}/input.json`;

/** The worker's exit code when no input arrived within NATIVE_WORKER_INPUT_WAIT_MS. */
export const WARM_WORKER_UNCLAIMED_EXIT = 75;
/** The delivery command's exit code when the worker already has an input. */
export const WARM_DELIVERY_ALREADY_DELIVERED = 2;

export function warmDeliveryCommand(file = WARM_INPUT_FILE): string[] {
  const script = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    `const file = ${JSON.stringify(file)};`,
    `if (fs.existsSync(file)) process.exit(${WARM_DELIVERY_ALREADY_DELIVERED});`,
    "fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });",
    "const chunks = [];",
    "process.stdin.on('data', (c) => chunks.push(c));",
    "process.stdin.on('end', () => {",
    "  const tmp = `${file}.partial`;",
    "  fs.writeFileSync(tmp, Buffer.concat(chunks), { flag: 'wx', mode: 0o400 });",
    `  try { fs.linkSync(tmp, file); } catch { fs.unlinkSync(tmp); process.exit(${WARM_DELIVERY_ALREADY_DELIVERED}); }`,
    "  fs.unlinkSync(tmp);",
    "});",
  ].join("\n");
  return ["node", "-e", script];
}
