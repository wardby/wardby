/**
 * Join (src/core/run-steps/join.ts): join_run, send_to_run and leave_run. A person with execute on
 * a run's agent joins one of its running runs, sends the agent messages (picked up at its next step)
 * or an interrupt (stops the current turn, then the message is handled), and leaves. While anyone is
 * joined the run stays open after the agent finishes, until the last person leaves or the run's
 * timeout. Phase 1: Claude Code coding runs that are not workflow runs.
 *
 * Access: the run must be visible (findReadableRun: execute on the agent, or the run's triggerer)
 * and the caller must hold execute on the agent now (a triggerer who lost it gets a 403).
 * TEAMS (#639, team-aware access): when team access lands, agentAccess/findReadableRun resolve
 * through accessFor/actsFor, so a team member's execute counts here with no change in this file.
 *
 * Secrets: a message is written only through RunStepWriter.recordJoin, which masks it by exact value
 * against the agent's secrets first; the answer returns the stored (masked) text, never the input.
 */
import { z } from "zod";
import { atLeast } from "../../core/grants.js";
import { joinRefusal, joinedPrincipals, MAX_JOIN_MESSAGE_CHARS } from "../../core/run-steps/join.js";
import { agentAccess, insufficientAgentAccess } from "../auth/access.js";
import type { McpRequestContext } from "../context.js";
import { McpError } from "../errors.js";
import type { WardbyMcpServer } from "../server.js";
import { findReadableRun } from "./run-access.js";
import { textResult } from "./text-result.js";

const RunIdSchema = z.object({ runId: z.string().trim().min(1).max(128) }).strict();
const SendSchema = z
  .object({
    runId: z.string().trim().min(1).max(128),
    message: z.string().trim().min(1).max(MAX_JOIN_MESSAGE_CHARS),
    interrupt: z.boolean().optional(),
  })
  .strict();

function parse<T>(schema: z.ZodType<T>, raw: unknown, tool: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    throw new McpError(400, `Invalid ${tool} arguments: ${details}`);
  }
  return parsed.data;
}

const REFUSALS: Record<string, string> = {
  run_not_running: "run_not_running: only a running run can be joined; this one is not running.",
  join_not_supported:
    "join_not_supported: joining works on Claude Code coding runs that are not workflow runs; this run is not one.",
  join_unavailable:
    "join_unavailable: this run keeps no run steps (WARDBY_RUN_STEPS or the agent's runSteps is off), so it cannot be joined.",
  run_not_joined: "run_not_joined: join the run with join_run before sending it messages.",
};

function refused(code: string): McpError {
  return new McpError(409, REFUSALS[code] ?? code);
}

/** The run, checked for access (execute now) and for joining; the writer that records join steps. */
async function joinableRun(ctx: McpRequestContext, runId: string, opts: { forLeave?: boolean } = {}) {
  const run = await findReadableRun(ctx, runId);
  const agent = await ctx.db.agent.findUnique({ where: { id: run.agentId }, select: { id: true, ownerId: true } });
  if (!agent) throw new McpError(404, `Run "${runId}" not found.`);
  const access = await agentAccess(ctx, agent);
  if (!atLeast("agent", access, "execute")) throw insufficientAgentAccess(agent.id, "execute", access);
  const writer = ctx.providers.runSteps;
  if (!writer?.recordJoin) throw refused("join_unavailable");
  // Leaving is always allowed, even once the run has ended: it only records the leave.
  if (!opts.forLeave) {
    const refusal = await joinRefusal(ctx.db, run.id);
    if (refusal) throw refused(refusal);
  }
  return { run, recordJoin: writer.recordJoin.bind(writer) };
}

/** A writer failure as the person sees it: a fixed code, or the generic failure. */
async function recorded<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (err) {
    const code = err instanceof Error ? err.message : "";
    if (code in REFUSALS) throw refused(code);
    throw err;
  }
}

export function registerJoinRunTools(mcp: WardbyMcpServer): void {
  mcp.registerTool({
    name: "join_run",
    scope: "runs:trigger",
    description:
      "Join a running Claude Code coding run so you can send its agent messages (send_to_run) while it works. " +
      "While anyone is joined the run stays open after the agent finishes its task, until the last person leaves " +
      "(leave_run) or the run's timeout. Follow the agent's replies with get_run_steps. Joining twice is harmless. " +
      "Needs execute access to the run's agent. Workflow runs and other coding agents cannot be joined yet.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { runId: { type: "string" } },
      required: ["runId"],
    },
    handler: async (raw: unknown, ctx) => {
      const { runId } = parse(RunIdSchema, raw, "join_run");
      const { run, recordJoin } = await joinableRun(ctx, runId);
      const joined = await joinedPrincipals(ctx.db, run.id);
      if (joined.has(ctx.principal.id)) {
        return textResult({ runId: run.id, joined: true, message: "You are already joined to this run." });
      }
      const { seq } = await recorded(recordJoin(run.id, { kind: "join", principalId: ctx.principal.id }));
      return textResult({
        runId: run.id,
        joined: true,
        seq,
        message:
          "Joined. Send messages with send_to_run; follow replies with get_run_steps (after: seq). The run stays " +
          "open until you leave with leave_run or its timeout is reached.",
      });
    },
  });

  mcp.registerTool({
    name: "send_to_run",
    scope: "runs:trigger",
    description:
      "Send a message to the agent of a run you joined (join_run). The agent picks it up at its next step; with " +
      `interrupt: true it stops what it is doing first and then handles the message. Up to ${MAX_JOIN_MESSAGE_CHARS} ` +
      "characters. The message appears in the run's steps (kind message or interrupt) for everyone who can see the " +
      "run; secret values in it are masked. Needs execute access to the run's agent.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        runId: { type: "string" },
        message: {
          type: "string",
          description: `What to tell the agent (up to ${MAX_JOIN_MESSAGE_CHARS} characters).`,
        },
        interrupt: {
          type: "boolean",
          description: "Stop the agent's current turn first (default false: it reads the message at its next step).",
        },
      },
      required: ["runId", "message"],
    },
    handler: async (raw: unknown, ctx) => {
      const { runId, message, interrupt } = parse(SendSchema, raw, "send_to_run");
      const { run, recordJoin } = await joinableRun(ctx, runId);
      if (!(await joinedPrincipals(ctx.db, run.id)).has(ctx.principal.id)) throw refused("run_not_joined");
      const kind = interrupt === true ? "interrupt" : "message";
      const { seq } = await recorded(recordJoin(run.id, { kind, principalId: ctx.principal.id, text: message }));
      return textResult({
        runId: run.id,
        seq,
        kind,
        message:
          kind === "interrupt"
            ? "Sent. The agent stops its current turn and then handles your message."
            : "Sent. The agent picks it up at its next step.",
      });
    },
  });

  mcp.registerTool({
    name: "leave_run",
    scope: "runs:trigger",
    description:
      "Leave a run you joined. When the last person leaves and the agent has finished, the run wraps up as usual " +
      "(opens or updates its pull request). Leaving when not joined is harmless. Needs execute access to the run's agent.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { runId: { type: "string" } },
      required: ["runId"],
    },
    handler: async (raw: unknown, ctx) => {
      const { runId } = parse(RunIdSchema, raw, "leave_run");
      const { run, recordJoin } = await joinableRun(ctx, runId, { forLeave: true });
      if (!(await joinedPrincipals(ctx.db, run.id)).has(ctx.principal.id)) {
        return textResult({ runId: run.id, joined: false, message: "You are not joined to this run." });
      }
      const { seq } = await recorded(recordJoin(run.id, { kind: "leave", principalId: ctx.principal.id }));
      return textResult({ runId: run.id, joined: false, seq, message: "Left the run." });
    },
  });
}
