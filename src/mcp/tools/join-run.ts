/**
 * Join (src/core/run-steps/join.ts): join_run, send_to_run and leave_run. A person with execute on
 * a run's agent joins one of its running runs, sends the agent messages (picked up at its next step)
 * or an interrupt (stops the current turn, then the message is handled), and leaves. While anyone is
 * joined the run stays open after the agent finishes, until the last person leaves or the run's
 * timeout. Native agent runs, and Claude Code coding runs that are not workflow runs.
 *
 * The actions and their access checks are join-actions.ts's, shared with the join API that
 * `wardby join -` calls (join-api.ts); join_run also returns that command's link when this server
 * serves the join API (join-link.ts).
 *
 * Access: the run must be visible (canReadRun: execute on the agent, or the run's triggerer) and the
 * caller must hold execute on the agent now (a triggerer who lost it gets a 403).
 * TEAMS (#639, team-aware access): when team access lands, canReadRun and the execute check resolve
 * through accessFor/actsFor, so a team member's execute counts here with no change in this file.
 *
 * Secrets: a message is written only through RunStepWriter.recordJoin, which masks it by exact value
 * against the agent's secrets first; the answer returns the stored (masked) text, never the input.
 * The join link is a credential: it is returned to the caller only, and never logged.
 */
import { z } from "zod";
import { MAX_JOIN_MESSAGE_CHARS } from "../../core/run-steps/join.js";
import { isOwnerAll } from "../auth/resource-server.js";
import { insufficientAgentAccess } from "../auth/access.js";
import type { McpRequestContext } from "../context.js";
import { McpError } from "../errors.js";
import type { WardbyMcpServer } from "../server.js";
import { JoinActionError, joinRunAs, leaveRunAs, sendToRunAs, type JoinActionDeps } from "./join-actions.js";
import { JOIN_COMMAND, joinCommandWithLink, joinLink, joinSessionExpiry, type JoinLinkPayload } from "./join-link.js";
import type { RunReader } from "./run-access.js";
import type { RunTranscriptLinkAudience } from "./run-transcript-download.js";
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

/** Each refusal's text, starting with its code (the help/errors article's name). */
export const JOIN_REFUSALS: Record<string, string> = {
  run_not_running: "run_not_running: only a running run can be joined; this one is not running.",
  join_not_supported:
    "join_not_supported: joining works on native agent runs and on Claude Code coding runs that are not workflow runs; this run is not one.",
  join_unavailable:
    "join_unavailable: this run keeps no run steps (WARDBY_RUN_STEPS or the agent's runSteps is off), so it cannot be joined.",
  run_not_joined: "run_not_joined: join the run with join_run before sending it messages.",
};

/** A join action's refusal as the MCP error the caller sees. */
function asMcpError(err: unknown, runId: string): unknown {
  if (!(err instanceof JoinActionError)) return err;
  if (err.code === "not_found") return new McpError(404, `Run "${runId}" not found.`);
  if (err.code === "insufficient_access" && err.detail) {
    return insufficientAgentAccess(err.detail.agentId, "execute", err.detail.access);
  }
  return new McpError(409, JOIN_REFUSALS[err.code] ?? err.code);
}

async function act<T>(runId: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw asMcpError(err, runId);
  }
}

function readerOf(ctx: McpRequestContext): RunReader {
  return { principalId: ctx.principal.id, operator: ctx.operator === true || isOwnerAll(ctx) };
}

function depsOf(ctx: McpRequestContext): JoinActionDeps {
  const writer = ctx.providers.runSteps;
  return { db: ctx.db, ...(writer?.recordJoin ? { recordJoin: writer.recordJoin.bind(writer) } : {}) };
}

export interface JoinRunToolOptions {
  /** Where `wardby join -` reaches this server's join API (join-api.ts); absent = no terminal link. */
  link?: { origin: () => Promise<string>; audience: RunTranscriptLinkAudience };
  now?: () => Date;
}

export function registerJoinRunTools(mcp: WardbyMcpServer, opts: JoinRunToolOptions = {}): void {
  /** The terminal link for this caller and run: valid until the run's deadline plus a short grace. */
  async function terminalLink(ctx: McpRequestContext, runId: string) {
    if (!opts.link) return {};
    const [run, coding] = await Promise.all([
      ctx.db.run.findUnique({ where: { id: runId }, select: { startedAt: true, timeoutSec: true } }),
      ctx.db.codingRun.findUnique({ where: { runId }, select: { timeoutSec: true } }),
    ]);
    const now = (opts.now ?? (() => new Date()))().getTime();
    const audience = opts.link.audience;
    const payload: JoinLinkPayload = {
      kind: "run-join",
      runId,
      principalId: ctx.principal.id,
      aud: audience,
      ...(audience === "stdio" && ctx.operator === true ? { operator: true } : {}),
      // An owner-all admin on HTTP can join from a terminal too; the role is re-checked on every call.
      ...(audience === "http" && isOwnerAll(ctx) ? { ownerAll: true, roles: [...(ctx.roles ?? [])].slice(0, 32) } : {}),
      // A coding run's time limit is on its CodingRun, a native run's on the run itself.
      exp: joinSessionExpiry(now, run?.startedAt ?? null, coding?.timeoutSec ?? run?.timeoutSec ?? 0),
    };
    const link = joinLink(await opts.link.origin(), await mcp.mintRequestState(payload));
    return {
      terminal: {
        command: joinCommandWithLink(link),
        pasteCommand: JOIN_COMMAND,
        link,
        note:
          "To join from a terminal instead, copy and run command. To keep the link out of your shell history " +
          "and the process list, run pasteCommand and paste the link when it asks. The link is a credential for " +
          "this run until it ends: do not share it.",
      },
    };
  }

  mcp.registerTool({
    name: "join_run",
    scope: "runs:trigger",
    description:
      "Join a running native agent run or Claude Code coding run so you can send its agent messages (send_to_run) while it works. " +
      "While anyone is joined the run stays open after the agent finishes its task, until the last person leaves " +
      "(leave_run) or the run's timeout. Follow the agent's replies with get_run_steps. Joining twice is harmless. " +
      "The answer also has terminal, for joining from a terminal chat: command (npx @wardby/cli@latest join with " +
      `the link, ready to copy), pasteCommand (${JOIN_COMMAND}, which asks for the link instead) and link. Give ` +
      "command to the user when they want that (or pasteCommand and link), and do not open the link yourself. " +
      "Needs execute access to the run's agent. Workflow runs and Codex or Gemini CLI coding runs cannot be joined yet.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { runId: { type: "string" } },
      required: ["runId"],
    },
    handler: async (raw: unknown, ctx) => {
      const { runId } = parse(RunIdSchema, raw, "join_run");
      const result = await act(runId, () => joinRunAs(depsOf(ctx), runId, readerOf(ctx)));
      const terminal = await terminalLink(ctx, result.run.id);
      if (result.already) {
        return textResult({
          runId: result.run.id,
          joined: true,
          message: "You are already joined to this run.",
          ...terminal,
        });
      }
      return textResult({
        runId: result.run.id,
        joined: true,
        seq: result.seq,
        message:
          "Joined. Send messages with send_to_run; follow replies with get_run_steps (after: seq). The run stays " +
          "open until you leave with leave_run or its timeout is reached.",
        ...terminal,
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
      const { run, seq, kind } = await act(runId, () =>
        sendToRunAs(depsOf(ctx), runId, readerOf(ctx), message, interrupt === true),
      );
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
      const { run, wasJoined, seq } = await act(runId, () => leaveRunAs(depsOf(ctx), runId, readerOf(ctx)));
      if (!wasJoined) return textResult({ runId: run.id, joined: false, message: "You are not joined to this run." });
      return textResult({ runId: run.id, joined: false, seq, message: "Left the run." });
    },
  });
}
