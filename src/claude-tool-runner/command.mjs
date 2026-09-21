import { spawn } from "node:child_process";

export const MAX_OUTPUT_BYTES = 64 * 1024;
export const MAX_COMMAND_BYTES = 16 * 1024;
export const MAX_TIMEOUT_MS = 120_000;

export function toolEnvironment() {
  return { HOME: "/home/wardby", LANG: "C.UTF-8", PATH: "/usr/local/bin:/usr/bin:/bin", TMPDIR: "/tmp" };
}

export async function runCommand(command, timeoutMs, workspacePath = "/workspace") {
  if (Buffer.byteLength(command) > MAX_COMMAND_BYTES) throw new Error("tool_command_too_large");
  const timeout = Math.max(1_000, Math.min(MAX_TIMEOUT_MS, timeoutMs));
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-lc", command], {
      cwd: workspacePath,
      env: toolEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks = [];
    let size = 0;
    let timedOut = false;
    const append = (chunk) => {
      if (size >= MAX_OUTPUT_BYTES) return;
      const bounded = Buffer.from(chunk).subarray(0, MAX_OUTPUT_BYTES - size);
      chunks.push(bounded);
      size += bounded.byteLength;
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeout);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), output: Buffer.concat(chunks).toString("utf8") });
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ code: 1, output: "tool execution failed" });
    });
  });
}
