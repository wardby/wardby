#!/usr/bin/env node
// `wardby-packages`: prints the package refusals the registry proxy recorded
// for this run in the last 15 minutes, one line each with the refusal code
// and what to do about it. Installed in the coding worker's images as
// /opt/wardby/bin/wardby-packages. For an install that failed without saying
// why: pip prints "from versions: none" and uv "403 Forbidden" for a package
// the registry refused. `--since=<ISO time>` narrows the window.
//
// `wardby-packages plan <file>...`: verifies Python lockfiles (a uv.lock or a
// pinned requirements file) with the registry first (pypi-plan.mjs), so pip can
// install every package one pins that the allowlist reaches. uv does this
// itself (uv-shim.mjs); pip has no hook.
import { planPythonLockfile } from "./pypi-plan.mjs";
import { formatRefusals, recentRefusals, registryAccess } from "./registry-refusals.mjs";

const args = process.argv.slice(2);
const access = registryAccess();
if (!access) {
  process.stderr.write("wardby-packages: no package registry is configured for this run.\n");
  process.exit(1);
}
if (args[0] === "plan") {
  const files = args.slice(1);
  if (files.length === 0) {
    process.stderr.write("usage: wardby-packages plan <uv.lock or requirements file>...\n");
    process.exit(2);
  }
  for (const file of files) {
    const lines = await planPythonLockfile(file, access);
    process.stdout.write(lines.length > 0 ? `${lines.join("\n")}\n` : `wardby: ${file} is already verified.\n`);
  }
} else {
  const sinceArgument = args.find((argument) => argument.startsWith("--since="));
  const since = sinceArgument ? new Date(sinceArgument.slice("--since=".length)) : undefined;
  const lines = formatRefusals(
    await recentRefusals(access, since && !Number.isNaN(since.getTime()) ? since : undefined),
  );
  process.stdout.write(
    lines.length > 0
      ? `${lines.join("\n")}\n`
      : "wardby: the package registry recorded no refusals for this run recently.\n",
  );
}
