/**
 * The stand-in for a run's worker tool, started by `wardby resume` through
 * the MCP config it writes: a stdio MCP server named `wardby_tools` that
 * offers `run_command` with the worker's input schema, so a resumed session
 * renders the run's calls. It runs nothing: every call answers with an error
 * telling the model the session moved and to use its local tools.
 *
 *   wardby resume-tools --checkout <dir> --from <podPath>   (hidden; started by Claude Code)
 */
import { parseArgs } from "node:util";
import { McpServer, fromJsonSchema, type McpServerFactory } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";

export const STAND_IN_SERVER_NAME = "wardby_tools";

export interface StandInOptions {
  /** The local checkout the session continues in. */
  checkout: string;
  /** The worker path the run's commands ran in. */
  from: string;
}

export function movedMessage(opts: StandInOptions): string {
  return (
    `This session moved from a wardby worker. ${opts.from} is now ${opts.checkout}. ` +
    `run_command only ran inside the worker; use your local tools (Bash, Read, Edit) in ${opts.checkout}.`
  );
}

/** The worker's run_command input schema (claude-tool-runner/main.mjs), so recorded calls still match it. */
const RUN_COMMAND_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", minLength: 1 },
    timeout_ms: { type: "integer" },
  },
  required: ["command"],
};

export function standInFactory(opts: StandInOptions): McpServerFactory {
  return () => {
    const server = new McpServer({ name: STAND_IN_SERVER_NAME, version: "1.0.0" });
    server.registerTool(
      "run_command",
      {
        description:
          "Ran shell commands inside the wardby worker during the run. Not available locally: it runs nothing. Use your own tools.",
        inputSchema: fromJsonSchema(RUN_COMMAND_SCHEMA),
      },
      () => ({ isError: true, content: [{ type: "text" as const, text: movedMessage(opts) }] }),
    );
    return server;
  };
}

export async function resumeToolsCommand(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: { checkout: { type: "string" }, from: { type: "string" } },
    strict: true,
  });
  if (!values.checkout || !values.from) throw new Error("usage: wardby resume-tools --checkout <dir> --from <path>");
  // Serves until Claude Code closes its end of stdin.
  serveStdio(standInFactory({ checkout: values.checkout, from: values.from }), {
    transport: new StdioServerTransport(),
  });
}
