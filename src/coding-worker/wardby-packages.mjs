#!/usr/bin/env node
// `wardby-packages`: prints the package refusals the registry proxy recorded
// for this run in the last 15 minutes, one line each with the refusal code
// and what to do about it. Installed in the coding worker's images as
// /opt/wardby/bin/wardby-packages. For an install that failed without saying
// why: pip prints "from versions: none" and uv "403 Forbidden" for a package
// the registry refused. `--since=<ISO time>` narrows the window.
import { formatRefusals, recentRefusals, registryAccess } from "./registry-refusals.mjs";

const sinceArgument = process.argv.slice(2).find((argument) => argument.startsWith("--since="));
const since = sinceArgument ? new Date(sinceArgument.slice("--since=".length)) : undefined;
const access = registryAccess();
if (!access) {
  process.stderr.write("wardby-packages: no package registry is configured for this run.\n");
  process.exit(1);
}
const lines = formatRefusals(await recentRefusals(access, since && !Number.isNaN(since.getTime()) ? since : undefined));
process.stdout.write(
  lines.length > 0
    ? `${lines.join("\n")}\n`
    : "wardby: the package registry recorded no refusals for this run recently.\n",
);
