import { spawnSync } from "node:child_process";

// No accepted exceptions. Any advisory fails CI.
//
// The Prisma CLI (a devDependency since Prisma 7) pins two flagged packages
// exactly; `overrides` in package.json forces patched versions, reviewed and
// tested against generate, validate, the migration drift check and the
// migration image (docs/security-deployment.md, SR-009):
// - deepmerge-ts 8.0.2 (GHSA-ggr8-5vv4-36mx, via @prisma/config), 2026-09-24;
// - mysql2 3.24.4 (GHSA-3f6p-5ww8-9rcr, GHSA-rgwj-5xj2-c3m3; Prisma Studio's
//   MySQL executor only), 2026-09-25.
// No allowlist entry backs them up on purpose: if a lockfile change ever
// dropped an override, the advisory would reappear here and fail the job.
//
// SR-009 is resolved for consumers too: the published package no longer
// depends on the Prisma CLI, so `npm install @wardby/cli` resolves neither
// package. scripts/npm-package-acceptance.mjs audits that install and fails
// on any high or critical advisory. Not covered: `wardby quickstart`/`doctor`
// fetch prisma@7.10.0 via npx onto the user's machine, which ignores our
// overrides and has no lockfile, so that cached CLI still carries
// deepmerge-ts 7.1.5 and mysql2 3.15.3. Low exploitability (it loads only our
// own shipped config; Studio's MySQL path is unused), and it never enters the
// installed package.
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
