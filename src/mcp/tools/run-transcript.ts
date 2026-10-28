/**
 * get_run_transcript: the way to continue a coding run's session locally.
 * The transcript itself never enters the caller's context: the tool returns
 * a short-lived signed download link and the command that imports it
 * (`npx wardby resume -`, which reads the link from standard input). Same access as get_run.
 */
import type { WardbyMcpServer } from "../server.js";
import { textResult } from "./text-result.js";
import { findReadableRun } from "./run-access.js";
import {
  RUN_TRANSCRIPT_LINK_TTL_MS,
  type RunTranscriptLinkAudience,
  type RunTranscriptLinkPayload,
} from "./run-transcript-download.js";

/** Builds the download URL for a minted token (HTTP: the canonical origin; stdio: the loopback server). */
export type RunTranscriptUrlBuilder = (token: string) => Promise<string>;

export interface RunTranscriptToolOptions {
  downloadUrl: RunTranscriptUrlBuilder;
  /** Whether the server has a blob store to serve transcripts from. */
  blobStoreConfigured: boolean;
  /** The host that serves the links this server mints (stdio's loopback server, or the HTTP route). */
  audience: RunTranscriptLinkAudience;
  now?: () => Date;
}

/** What each status other than `stored` means, for the caller. */
const MEANINGS: Record<string, string> = {
  none: "No transcript was recorded for this run. Turn on codingProfile.sessionResume for the agent; it applies to runs started after that.",
  too_large: "The run's transcript was larger than RUN_TRANSCRIPT_MAX_BYTES, so it was not stored.",
  not_captured:
    "No transcript was stored for this run (see reason): for example the server had no blob store, the run was stopped or timed out, or it never finished a turn.",
  failed: "Storing this run's transcript failed (see reason). Nothing was stored.",
  expired: "The transcript was deleted after RUN_TRANSCRIPT_RETENTION_DAYS.",
  unavailable: "The transcript was stored, but this server has no blob store configured to serve it from.",
  unsupported: "Resuming this kind of run locally is not supported yet: only Claude Code coding runs can be resumed.",
};

function notStored(runId: string, status: string, reason?: string | null) {
  return textResult({ runId, status, ...(reason ? { reason } : {}), meaning: MEANINGS[status] });
}

export function registerRunTranscriptTool(mcp: WardbyMcpServer, opts: RunTranscriptToolOptions): void {
  mcp.registerTool({
    name: "get_run_transcript",
    description:
      "Get a short-lived download link for a Claude Code coding run's session transcript, and the command that continues the session locally (npx wardby resume -, which asks for the link). Give the user the command and the link to run in a terminal inside a clone of the run's repository; do not fetch the link yourself. Same access as get_run. The link works for 10 minutes.",
    scope: "agents:read",
    inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] },
    handler: async (args: { runId: string }, ctx) => {
      const run = await findReadableRun(ctx, args.runId);
      const codingRun = await ctx.db.codingRun.findUnique({
        where: { runId: run.id },
        select: { provider: true, repository: true, headRef: true, resultBranch: true, baseSha: true },
      });
      if (!codingRun) return notStored(run.id, "unsupported", "not_a_coding_run");
      if (codingRun.provider !== "claude-code") return notStored(run.id, "unsupported", "provider_unsupported");
      const row = await ctx.db.runTranscript.findUnique({ where: { runId: run.id } });
      if (!row) return notStored(run.id, "none");
      if (row.status !== "stored" || !row.sessionId) return notStored(run.id, row.status, row.reason);
      const now = (opts.now ?? (() => new Date()))();
      if (row.expiresAt.getTime() <= now.getTime()) return notStored(run.id, "expired");
      if (!opts.blobStoreConfigured) return notStored(run.id, "unavailable", "no_blob_store");

      const exp = now.getTime() + RUN_TRANSCRIPT_LINK_TTL_MS;
      const payload: RunTranscriptLinkPayload = {
        kind: "run-transcript",
        runId: run.id,
        principalId: ctx.principal.id,
        aud: opts.audience,
        ...(ctx.operator && opts.audience === "stdio" ? { operator: true } : {}),
        exp,
      };
      const url = await opts.downloadUrl(await mcp.mintRequestState(payload));
      const linkExpiresAt = new Date(exp).toISOString();
      return textResult({
        runId: run.id,
        status: "stored",
        sessionId: row.sessionId,
        provider: codingRun.provider,
        repository: codingRun.repository,
        branch: codingRun.resultBranch ?? codingRun.headRef,
        baseSha: codingRun.baseSha,
        sizeBytes: row.sizeBytes,
        expiresAt: row.expiresAt.toISOString(),
        download: { url, expiresAt: linkExpiresAt },
        command: "npx wardby resume -",
        note: "Run the command in a terminal, inside a clone of the repository (not needed for a local: repository), and paste download.url when it asks. Reading the link this way keeps it out of shell history and the process list. The link is a credential for this transcript until it expires: do not share it.",
      });
    },
  });
}
