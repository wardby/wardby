#!/usr/bin/env node

import { CLI_USAGE } from "./cli-help.js";
import { packageVersion } from "./package-version.js";

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
  } else if (command === "secret" && process.argv[3] === "connect") {
    // Runs on the owner's machine: no environment, database, or server runtime.
    const { secretConnectCommand } = await import("./oauth-loopback/connect.js");
    process.exitCode = await secretConnectCommand(process.argv.slice(4));
  } else if (command === "resume-tools") {
    // Hidden: the stand-in tool server `wardby resume` configures Claude Code to start.
    const { resumeToolsCommand } = await import("./coding/transcript/resume/stand-in.js");
    await resumeToolsCommand(process.argv.slice(3));
  } else if (command === "claude-plugin") {
    // Sets up the Claude Code plugin on this machine: no environment, database, or server runtime.
    const { claudePluginCommand } = await import("./claude-plugin/command.js");
    process.exitCode = await claudePluginCommand(process.argv.slice(3));
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
