import type { PrismaClient } from "#prisma";
import { redactExactSecretValues } from "../../core/secret-spans.js";
import { sameSecretVersions, type SecretVersion } from "../../core/secret-versions.js";
import { MAX_PLAN_FILES_WIRE_BYTES, parsePlanFilesOutputJson, redactTokenShapedValues } from "../protocol.js";
import { assertPlanFilesWithinLimits, type PlanFile } from "./store.js";

export type PlanFilesStatus =
  | "stored"
  | "plan_too_large"
  | "plan_folder_invalid"
  | "plan_files_failed"
  | "plan_tool_unavailable"
  | "plan_files_unsupported"
  | "plan_files_missing"
  | "secrets_changed"
  | "secrets_unavailable";

export type { PlanFile };

export interface PlanFilesRecorderDeps {
  db: Pick<PrismaClient, "codingRun" | "codingRunPlanFile" | "$transaction">;
  secretValues: (agentId: string) => Promise<string[]>;
  secretVersions: (agentId: string) => Promise<SecretVersion[]>;
}

export interface RecordPlanFilesInput {
  runId: string;
  agentId: string;
  launchSecretVersions?: readonly SecretVersion[];
  /** Undefined read: the launcher has no readPlanFiles (none of the shipped ones; Docker, Kubernetes, Substrate and the fake all have it). */
  read?: (maxBytes: number) => Promise<string | undefined>;
}

const DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * Stores a coding run's returned plan folder. The worker's file is untrusted: parsed and bounded
 * again; each file is redacted by exact value against the agent's secret values, and a file that
 * still holds a token-shaped value is withheld (its path recorded, never its text). Nothing is
 * stored when a delivered secret changed while the run ran. Never throws, never logs content.
 */
export class PlanFilesRecorder {
  constructor(private readonly deps: PlanFilesRecorderDeps) {}

  async record(input: RecordPlanFilesInput): Promise<PlanFilesStatus> {
    const status = await this.capture(input).catch((): PlanFilesStatus => "plan_files_failed");
    if (status !== "stored") await this.writeStatus(input.runId, status).catch(() => undefined);
    return status;
  }

  async storeChecked(
    input: Omit<RecordPlanFilesInput, "read">,
    files: PlanFile[],
    skipped: string[],
  ): Promise<PlanFilesStatus> {
    const status = await this.redactAndStore(input, files, skipped).catch((): PlanFilesStatus => "plan_files_failed");
    if (status !== "stored") await this.writeStatus(input.runId, status).catch(() => undefined);
    return status;
  }

  private async capture(input: RecordPlanFilesInput): Promise<PlanFilesStatus> {
    if (!input.read) return "plan_files_unsupported";
    let text: string | undefined;
    try {
      text = await input.read(MAX_PLAN_FILES_WIRE_BYTES);
    } catch (error) {
      return error instanceof Error && error.message === "plan_files_too_large"
        ? "plan_too_large"
        : "plan_files_failed";
    }
    if (text === undefined) return "plan_files_missing";
    let parsed;
    try {
      parsed = parsePlanFilesOutputJson(text);
    } catch {
      return "plan_files_failed";
    }
    if (parsed.runId !== input.runId) return "plan_files_failed";
    if (parsed.status === "error") return parsed.error;
    const files: PlanFile[] = [];
    const undecodable: string[] = [];
    for (const file of parsed.files) {
      try {
        files.push({ path: file.path, content: DECODER.decode(Buffer.from(file.contentBase64, "base64")) });
      } catch {
        undecodable.push(file.path);
      }
    }
    return this.redactAndStore(input, files, parsed.skipped, undecodable);
  }

  private async redactAndStore(
    input: Omit<RecordPlanFilesInput, "read">,
    files: PlanFile[],
    skipped: string[],
    alreadyWithheld: string[] = [],
  ): Promise<PlanFilesStatus> {
    try {
      assertPlanFilesWithinLimits(files);
    } catch (error) {
      return error instanceof Error && error.message === "plan_too_large" ? "plan_too_large" : "plan_files_failed";
    }
    let secrets: string[];
    try {
      secrets = await this.deps.secretValues(input.agentId);
    } catch {
      return "secrets_unavailable";
    }
    // Read after the values, as RunTranscriptRecorder does: a change before this check is caught here.
    if (!input.launchSecretVersions) return "secrets_changed";
    let current: SecretVersion[];
    try {
      current = await this.deps.secretVersions(input.agentId);
    } catch {
      return "secrets_unavailable";
    }
    if (!sameSecretVersions(input.launchSecretVersions, current)) return "secrets_changed";
    const kept: PlanFile[] = [];
    const withheld = [...alreadyWithheld];
    for (const file of files) {
      const redacted = redactExactSecretValues(file.content, secrets);
      if (redactTokenShapedValues(redacted) !== redacted) withheld.push(file.path);
      else kept.push({ path: file.path, content: redacted });
    }
    await this.deps.db.$transaction([
      this.deps.db.codingRunPlanFile.deleteMany({ where: { runId: input.runId, direction: "output" } }),
      this.deps.db.codingRunPlanFile.createMany({
        data: kept.map((f) => ({ runId: input.runId, direction: "output", path: f.path, content: f.content })),
      }),
      this.deps.db.codingRun.update({
        where: { runId: input.runId },
        data: { planFilesStatus: "stored", planFilesWithheld: withheld, planFilesSkipped: skipped },
      }),
    ]);
    return "stored";
  }

  private async writeStatus(runId: string, status: PlanFilesStatus): Promise<void> {
    await this.deps.db.codingRun.update({ where: { runId }, data: { planFilesStatus: status } });
  }
}
