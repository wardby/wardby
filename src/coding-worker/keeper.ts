import { mkdir, chmod } from "node:fs/promises";

export const STORAGE_ROOT = "/run/reevo/storage";
export const STORAGE_READY_MESSAGE = "reevo_storage_ready";
const STORAGE_DIRECTORIES = ["workspace", "git", "input", "output", "tool"] as const;

export async function prepareStorage(root = STORAGE_ROOT): Promise<void> {
  for (const directory of STORAGE_DIRECTORIES) {
    const path = `${root}/${directory}`;
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700);
  }
}

export async function main(): Promise<void> {
  await prepareStorage();
  process.stdout.write(`${STORAGE_READY_MESSAGE}\n`);
  await new Promise<void>((resolve) => {
    const keepAlive = setInterval(() => undefined, 60_000);
    const stop = () => {
      clearInterval(keepAlive);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(() => {
    process.exitCode = 1;
  });
}
