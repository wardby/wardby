import { spawnSync } from "node:child_process";

const acceptedException = {
  advisory: "GHSA-ggr8-5vv4-36mx",
  packages: new Set(["@prisma/config", "deepmerge-ts", "prisma"]),
  accepted: "2026-09-06",
  expires: Date.parse("2026-10-07T00:00:00Z"),
};

function auditPassesPolicy(output, status) {
  let report;
  try {
    report = JSON.parse(output);
  } catch {
    return false;
  }

  if (report.auditReportVersion !== 2 || typeof report.vulnerabilities !== "object" || typeof report.metadata?.vulnerabilities !== "object") return false;
  const vulnerabilities = report.vulnerabilities ?? {};
  const packages = Object.keys(vulnerabilities);
  if (packages.length === 0) return status === 0;
  if (Date.now() >= acceptedException.expires || packages.some((name) => !acceptedException.packages.has(name))) return false;

  const advisoryUrls = Object.values(vulnerabilities).flatMap((entry) =>
    (entry.via ?? []).flatMap((via) => typeof via === "object" && typeof via.url === "string" ? [via.url] : []),
  );
  return advisoryUrls.length > 0 && advisoryUrls.every((url) => url.endsWith("/" + acceptedException.advisory));
}

const results = [];
for (const args of [["audit", "--omit=dev", "--json"], ["audit", "--json"]]) {
  const result = spawnSync("npm", args, { encoding: "utf8" });
  console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  const passed = auditPassesPolicy(result.stdout, result.status ?? 1);
  if (result.status !== 0 && passed) {
    console.warn(`${args.join(" ")}: accepted ${acceptedException.advisory} through 2026-10-06 (${acceptedException.accepted} owner approval).`);
  }
  results.push(passed ? 0 : (result.status ?? 1));
}
process.exitCode = results.some((code) => code !== 0) ? 1 : 0;
