import { spawnSync } from "node:child_process";
const results = [];
for (const args of [["audit", "--omit=dev", "--json"], ["audit", "--json"]]) {
  const result = spawnSync("npm", args, { encoding: "utf8" });
  console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  results.push(result.status ?? 1);
}
// Do not silently waive Prisma or downgrade it. Both reports remain CI failures until resolved.
process.exitCode = results.some((code) => code !== 0) ? 1 : 0;
