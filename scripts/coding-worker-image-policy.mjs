import { readFile } from "node:fs/promises";

const dockerfile = await readFile(new URL("../src/coding-worker/Dockerfile", import.meta.url), "utf8");
const workerPackage = JSON.parse(await readFile(new URL("../src/coding-worker/package.json", import.meta.url), "utf8"));
const workerLock = JSON.parse(
  await readFile(new URL("../src/coding-worker/package-lock.json", import.meta.url), "utf8"),
);
const fromLines = dockerfile.split("\n").filter((line) => /^FROM\s/i.test(line));
const failures = [];
if (!fromLines.length || fromLines.some((line) => !/@sha256:[0-9a-f]{64}(?:\s|$)/i.test(line))) {
  failures.push("every FROM image must be pinned by sha256 digest");
}
const sdkVersion = workerPackage.dependencies?.["@openai/codex-sdk"];
const lockedSdk = workerLock.packages?.["node_modules/@openai/codex-sdk"];
if (sdkVersion !== "0.153.4" || lockedSdk?.version !== sdkVersion || !lockedSdk?.integrity) {
  failures.push("Codex SDK must be exactly pinned with lockfile integrity");
}
for (const required of ["--no-install-recommends", "USER 10001:10001", 'ENTRYPOINT ["node"', "npm ci --omit=dev"]) {
  if (!dockerfile.includes(required)) failures.push(`missing image control: ${required}`);
}
for (const mutable of [/^FROM\s+[^\s@]+:[^\s@]+\s/im, /npm install\s+(?!.*--package-lock)/i]) {
  if (mutable.test(dockerfile)) failures.push(`mutable production input matched ${mutable}`);
}
if (failures.length) {
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("coding worker image policy passed\n");
}
