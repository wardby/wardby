import { readFile } from "node:fs/promises";

const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
const kindArg = process.argv.slice(2).find((arg) => arg.startsWith("--kind="));
const kind = kindArg ? kindArg.slice("--kind=".length) : "runtime";
if (kind !== "runtime" && kind !== "driver") {
  process.stderr.write(`unknown --kind "${kind}" (expected "runtime" or "driver")\n`);
  process.exitCode = 1;
  process.exit();
}
const dockerfilePath = positional[0] ?? "../src/coding-worker/Dockerfile";
const dockerfile = await readFile(new URL(dockerfilePath, import.meta.url), "utf8");
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
// The driver image is an intermediate layer other Dockerfiles build on top
// of — it never sets USER/ENTRYPOINT itself (those depend on whatever
// language toolchain and hardening checks the derived Dockerfile adds).
const requiredControls =
  kind === "driver"
    ? ["--no-install-recommends", "npm ci --omit=dev"]
    : ["--no-install-recommends", "USER 10001:10001", 'ENTRYPOINT ["node"', "npm ci --omit=dev"];
for (const required of requiredControls) {
  if (!dockerfile.includes(required)) failures.push(`missing image control: ${required}`);
}
for (const mutable of [/^FROM\s+[^\s@]+:[^\s@]+\s/im, /npm install\s+(?!.*--package-lock)/i]) {
  if (mutable.test(dockerfile)) failures.push(`mutable production input matched ${mutable}`);
}
if (failures.length) {
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`coding worker image policy passed (${dockerfilePath})\n`);
}
