import { spawnSync } from "node:child_process";

// No accepted exceptions. Any advisory fails CI.
//
// SR-009 (GHSA-ggr8-5vv4-36mx, deepmerge-ts via prisma -> @prisma/config) used
// to be allowlisted here. It is now removed from this repository's tree by the
// `overrides` entry in package.json, which forces deepmerge-ts 8.0.2 under
// Prisma 6 -- reviewed and tested 2026-09-24 against validate, generate,
// format, the migration drift check and the full suite.
//
// The exception was deleted rather than left in place on purpose. With the
// override, audit is clean and the exception is never consulted, so it had
// become dead code -- and a dead allowlist entry is a trap: if a lockfile
// change ever dropped the override, it would silently re-permit the advisory.
// Removing it makes the override load-bearing, enforced here.
//
// SR-009 still applies to people who `npm install @wardby/cli` (npm ignores a
// dependency's overrides), which this job cannot audit. See
// docs/security-deployment.md.
const acceptedException = null;

function auditPassesPolicy(output, status) {
  let report;
  try {
    report = JSON.parse(output);
  } catch {
    return false;
  }

  if (
    report.auditReportVersion !== 2 ||
    typeof report.vulnerabilities !== "object" ||
    typeof report.metadata?.vulnerabilities !== "object"
  )
    return false;
  const vulnerabilities = report.vulnerabilities ?? {};
  const packages = Object.keys(vulnerabilities);
  if (packages.length === 0) return status === 0;
  if (
    acceptedException === null ||
    Date.now() >= acceptedException.expires ||
    packages.some((name) => !acceptedException.packages.has(name))
  )
    return false;

  const advisoryUrls = Object.values(vulnerabilities).flatMap((entry) =>
    (entry.via ?? []).flatMap((via) => (typeof via === "object" && typeof via.url === "string" ? [via.url] : [])),
  );
  return advisoryUrls.length > 0 && advisoryUrls.every((url) => url.endsWith("/" + acceptedException.advisory));
}

const results = [];
for (const args of [
  ["audit", "--omit=dev", "--json"],
  ["audit", "--json"],
]) {
  const result = spawnSync("npm", args, { encoding: "utf8" });
  console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  const passed = auditPassesPolicy(result.stdout, result.status ?? 1);
  if (result.status !== 0 && passed) {
    console.warn(
      `${args.join(" ")}: accepted ${acceptedException.advisory} (${acceptedException.accepted} owner approval).`,
    );
  }
  results.push(passed ? 0 : (result.status ?? 1));
}
process.exitCode = results.some((code) => code !== 0) ? 1 : 0;
