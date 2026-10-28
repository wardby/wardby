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

async function main(): Promise<void> {
  const command = process.argv[2];

  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(`${CLI_USAGE}\n`);
  } else if (command === "--version" || command === "-v") {
    process.stdout.write(`${packageVersion()}\n`);
  } else if (command === "quickstart") {
    const { quickstartCommand } = await import("./quickstart/index.js");
    await quickstartCommand(process.argv.slice(3));
  } else if (command === "doctor") {
    const { doctorCommand } = await import("./quickstart/index.js");
    await doctorCommand(process.argv.slice(3));
  } else if (command === "status") {
    const { statusCommand } = await import("./quickstart/index.js");
    await statusCommand(process.argv.slice(3));
  } else if (command === "logs") {
    const { logsCommand } = await import("./quickstart/index.js");
    await logsCommand(process.argv.slice(3));
  } else if (command === "down") {
    const { downCommand } = await import("./quickstart/index.js");
    await downCommand(process.argv.slice(3));
  } else if (command === "help") {
    // Help is bundled and offline: avoid loading the runtime environment,
    // database client, or HTTP runtime just to search documentation.
    const { helpCommand } = await import("./help/cli.js");
    await helpCommand(process.argv.slice(3));
  } else if (command === "resume") {
    // Runs on a developer's machine: no environment, database, or server runtime.
    const { resumeCommand } = await import("./coding/transcript/resume/command.js");
    process.exitCode = await resumeCommand(process.argv.slice(3));
  } else if (command === "resume-tools") {
    // Hidden: the stand-in tool server `wardby resume` configures Claude Code to start.
    const { resumeToolsCommand } = await import("./coding/transcript/resume/stand-in.js");
    await resumeToolsCommand(process.argv.slice(3));
  } else if (command === "knowledge") {
    // Offline bundle validation: no environment, database, or HTTP runtime.
    const { knowledgeCommand } = await import("./knowledge/cli.js");
    await knowledgeCommand(process.argv.slice(3));
  } else {
    await import("./cli.js");
  }
}

main().catch((error: unknown) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
