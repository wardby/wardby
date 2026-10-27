#!/usr/bin/env node
// TEST ONLY: runs Flow J (scripted mode: Jira issue → build → PR → review → merge → Jira
// write-back) on the Flow G kind cluster. See tools/wardby-sim/src/flow-j/runner.ts; bring the
// cluster up first with `bash deploy/kind-coding/flow-g-up.sh`.
//
//   node scripts/release/flow-j.mjs --agent codex|claude [--variant default|duplicate|jira429] [--keep]
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const result = spawnSync(
  "npx",
  ["tsx", join(root, "tools/wardby-sim/src/flow-j/runner.ts"), ...process.argv.slice(2)],
  {
    cwd: root,
    stdio: "inherit",
  },
);
process.exit(result.status ?? 2);
