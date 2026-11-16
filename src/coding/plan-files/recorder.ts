import { Prisma, type PrismaClient } from "#prisma";
import { redactExactSecretValues, withEscapedForms } from "../../core/secret-spans.js";
import { sameSecretVersions, type SecretVersion } from "../../core/secret-versions.js";
import { MAX_PLAN_FILES_WIRE_BYTES, parsePlanFilesOutputJson } from "../protocol.js";
import { REDACTED, redactSecrets } from "../redact.js";
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

/**
 * The stored shape of CodingRun.planFilesWithheld and CodingRun.planFilesSkipped: the paths that can be
 * named, and how many were left unnamed (a path that itself holds a secret value or a token-shaped
 * value is never stored, only counted).
 */
export interface PlanFilesPathList {
  paths: string[];
  unnamed: number;
}

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
 * again; each file is redacted by exact value against the agent's secret values (and their JSON-escaped
 * forms, as RunTranscriptRecorder does), and a file that still holds a token-shaped value (redactSecrets:
 * the run's rrp_/rrg_/rmt_ tokens and Bearer values included) is withheld (its path recorded, never its
 * text). A path that holds a secret or token-shaped value is never stored, only counted. Nothing is
 * stored when a delivered secret changed while the run ran; every outcome other than "stored" removes
 * the run's stored output files. Never throws, never logs content.
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
    const status = await this.redactAndStore(input, files, { paths: skipped, unnamed: 0 }).catch(
      (): PlanFilesStatus => "plan_files_failed",
    );
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
    return this.redactAndStore(input, files, { paths: parsed.skipped, unnamed: parsed.skippedUnnamed }, undecodable);
  }

  private async redactAndStore(
    input: Omit<RecordPlanFilesInput, "read">,
    files: PlanFile[],
    skipped: PlanFilesPathList,
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
    // As RunTranscriptRecorder: every value in its raw and JSON-escaped forms, however short.
    const escaped = withEscapedForms(secrets);
    const holdsSecret = (text: string): boolean => redactSecrets(text, escaped) !== text;
    const kept: PlanFile[] = [];
    const withheld: PlanFilesPathList = { paths: [], unnamed: 0 };
    const withhold = (path: string): void => {
      if (holdsSecret(path)) withheld.unnamed += 1;
      else withheld.paths.push(path);
    };
    alreadyWithheld.forEach(withhold);
    for (const file of files) {
      const redacted = redactExactSecretValues(file.content, escaped, { marker: REDACTED, minLength: 1 });
      if (holdsSecret(file.path) || redactSecrets(redacted) !== redacted) withhold(file.path);
      else kept.push({ path: file.path, content: redacted });
    }
    const skippedNamed = skipped.paths.filter((path) => !holdsSecret(path));
    const skippedList: PlanFilesPathList = {
      paths: skippedNamed,
      unnamed: skipped.unnamed + skipped.paths.length - skippedNamed.length,
    };
    await this.deps.db.$transaction([
      this.deps.db.codingRunPlanFile.deleteMany({ where: { runId: input.runId, direction: "output" } }),
      this.deps.db.codingRunPlanFile.createMany({
        data: kept.map((f) => ({ runId: input.runId, direction: "output", path: f.path, content: f.content })),
      }),
      this.deps.db.codingRun.update({
        where: { runId: input.runId },
        data: {
          planFilesStatus: "stored",
          planFilesWithheld: { ...withheld },
          planFilesSkipped: { ...skippedList },
        },
      }),
    ]);
    return "stored";
  }

  /** A non-stored outcome: no output files (and no path lists) from an earlier record survive it. */
  private async writeStatus(runId: string, status: PlanFilesStatus): Promise<void> {
    await this.deps.db.$transaction([
      this.deps.db.codingRunPlanFile.deleteMany({ where: { runId, direction: "output" } }),
      this.deps.db.codingRun.update({
        where: { runId },
        data: { planFilesStatus: status, planFilesWithheld: Prisma.DbNull, planFilesSkipped: Prisma.DbNull },
      }),
    ]);
  }
}
