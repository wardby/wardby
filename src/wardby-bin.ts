#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { CLI_USAGE } from "./cli-help.js";

function packageVersion(): string {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
  };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("invalid_package_version");
  }
  return packageJson.version;
}

const command = process.argv[2];

if (command === undefined || command === "--help" || command === "-h") {
  process.stdout.write(`${CLI_USAGE}\n`);
} else if (command === "--version" || command === "-v") {
  process.stdout.write(`${packageVersion()}\n`);
} else {
  await import("./cli.js");
}
