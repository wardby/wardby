/**
 * Building from an approved plan (docs/private spec §7). A coding agent with `buildFromPlan` builds
 * from the plan set for its repository and number made by a planner its owner can execute; a set
 * any counted document of which is not approved refuses the run before it starts. The approved
 * versions go to the builder twice: the Markdown as an untrusted section of the stored request (R9,
 * never cut), and every document as files in the plan folder (R14), so the rewritten links name files
 * that exist. All of it is redacted by exact value against the builder's secret values at send time;
 * without them the gate refuses rather than pass unchecked text. Errors name documents by path only.
 */
import type { PrismaClient } from "#prisma";
import { byteLength, MAX_CODING_TASK_BYTES, PLAN_FOLDER_PATH } from "../../coding/protocol.js";
import { normalizeHostedRepository } from "../../coding/code-host.js";
import { assertPlanFilesWithinLimits, type PlanFile } from "../../coding/plan-files/store.js";
import { loadContent } from "../documents/files.js";
import { withHtmlEscapedForms } from "../documents/formats/boards.js";
import { atLeast, effectiveAccess } from "../grants.js";
import { loadAgentSecretValues } from "../secret-guard.js";
import { redactExactSecretValues } from "../secret-spans.js";
import { wrapUntrusted } from "../untrusted-content.js";
import { rewriteLinksForBuilder } from "./links.js";
import type { SecretCipher } from "./publish.js";
import { PlanRefusedError } from "./refusal.js";

export interface BuildPlan {
  planSetId: string;
  number: number;
  versions: Array<{ documentId: string; path: string; kind: "document" | "design"; versionNumber: number }>;
  /** The approved Markdown documents (links rewritten), redacted, inside wrapUntrusted("plan", …): part of the stored request (R9). */
  taskSection: string;
  /** Every approved document as files under the plan folder, redacted: Markdown at <path> (R14), a design's files under <path>. */
  planInputFiles: PlanFile[];
}

/** What resolveBuildPlan reads, plus what loadAgentSecretValues (src/core/secret-guard.ts) reads. */
export type BuildPlanDb = Pick<PrismaClient, "planSet" | "documentVersion" | "documentFile" | "resourceGrant"> &
  Parameters<typeof loadAgentSecretValues>[0];

/** `plan.md` first, then by path: the order of the task section, the versions and the PR line. */
function byPlanOrder(a: { planPath: string | null }, b: { planPath: string | null }): number {
  if (a.planPath === "plan.md") return -1;
  if (b.planPath === "plan.md") return 1;
  return (a.planPath ?? "").localeCompare(b.planPath ?? "");
}

/** A plan set's repository as stored (a resolved run's id), for a case-insensitive lookup. */
function planRepositoryKey(repository: string): string {
  try {
    return normalizeHostedRepository(repository);
  } catch {
    return repository.trim();
  }
}

/**
 * The key as an exact ILIKE pattern: Prisma's case-insensitive `equals` compiles to ILIKE without
 * escaping, so `_` and `%` would be wildcards (acme/my_repo matching acme/my-repo). Postgres's
 * default LIKE escape character is the backslash, so it is escaped first.
 */
function exactInsensitivePattern(key: string): string {
  return key.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * The `where` filter for a plan set's repository, matched the way the host compares names
 * (case-insensitively, exactly). Shared by every lookup of a set by its repository and number.
 */
export function planRepositoryFilter(repository: string): { equals: string; mode: "insensitive" } {
  return { equals: exactInsensitivePattern(planRepositoryKey(repository)), mode: "insensitive" };
}

/**
 * The approved plan for a builder's run, or null when no plan set it may see exists (the run goes
 * ahead as today). Throws PlanRefusedError: plan_not_approved (a counted document still waiting, an
 * ownerless builder, or no way to read the builder's secret values) or plan_too_large (the approved
 * plan cannot fit). Repository names match the way the host compares them (case-insensitively), and
 * when several visible sets share the repository and number the newest wins.
 */
export async function resolveBuildPlan(
  db: BuildPlanDb,
  cipher: SecretCipher | undefined,
  input: {
    builderAgentId: string;
    builderOwnerId: string | null;
    repository: string;
    number: number;
    ticket?: number;
  },
): Promise<BuildPlan | null> {
  // Fail closed: without an owner there is nobody to check the planner's access against.
  if (input.builderOwnerId === null) {
    throw new PlanRefusedError("plan_not_approved", "the builder has no owner to check the plan's access against");
  }
  const sets = await db.planSet.findMany({
    where: {
      repository: planRepositoryFilter(input.repository),
      number: input.number,
    },
    include: {
      agent: { select: { id: true, ownerId: true } },
      documents: { where: { removedFromPlan: false, planPath: { not: null } }, include: { currentVersion: true } },
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  // A builder never pulls in a plan its owner cannot see: only a planner the owner can execute counts.
  let set: (typeof sets)[number] | undefined;
  for (const candidate of sets) {
    const access = await effectiveAccess(db, "agent", candidate.agent, input.builderOwnerId);
    if (atLeast("agent", access, "execute")) {
      set = candidate;
      break;
    }
  }
  if (!set) return null;

  const documents = [...set.documents].sort(byPlanOrder);
  const waiting = documents.filter((d) => d.reviewState !== "approved" || !d.currentVersion).map((d) => d.planPath!);
  if (waiting.length > 0) {
    throw new PlanRefusedError("plan_not_approved", `still waiting: ${waiting.join(", ")}`, waiting);
  }
  // An approved document is locked: its current version is the approved one.
  return composeBuildPlan(
    db,
    cipher,
    { builderAgentId: input.builderAgentId, planSetId: set.id, number: set.number, ticket: input.ticket },
    documents.map((d) => ({
      id: d.id,
      path: d.planPath!,
      kind: d.kind === "design" ? ("design" as const) : ("document" as const),
      version: d.currentVersion!,
    })),
  );
}

/**
 * A continuation's plan (a fix round, a follow-up): exactly the versions its root run was built from,
 * whatever their documents' review state is now, so reopening a document never refuses a fix round of
 * a build that already started. The same files, task section and redaction as a fresh build. Throws
 * PlanRefusedError plan_not_approved when a recorded version is gone or the secret values cannot be read.
 */
export async function resolveRecordedBuildPlan(
  db: BuildPlanDb,
  cipher: SecretCipher | undefined,
  input: {
    builderAgentId: string;
    planSetId: string;
    number: number;
    versions: BuildPlan["versions"];
    ticket?: number;
  },
): Promise<BuildPlan> {
  const rows = await db.documentVersion.findMany({
    where: {
      OR: input.versions.map((v) => ({ documentId: v.documentId, number: v.versionNumber })),
    },
    select: { id: true, documentId: true, number: true, format: true, markdown: true },
  });
  const documents = input.versions.map((v) => {
    const version = rows.find((r) => r.documentId === v.documentId && r.number === v.versionNumber);
    return version ? { id: v.documentId, path: v.path, kind: v.kind, version } : null;
  });
  const missing = input.versions.filter((_, i) => documents[i] === null).map((v) => v.path);
  if (missing.length > 0) {
    throw new PlanRefusedError("plan_not_approved", `approved version no longer available: ${missing.join(", ")}`);
  }
  return composeBuildPlan(
    db,
    cipher,
    { builderAgentId: input.builderAgentId, planSetId: input.planSetId, number: input.number, ticket: input.ticket },
    documents.filter((d) => d !== null),
  );
}

/** The builder's input from the chosen versions: redacted files, and the wrapped, never-cut task section. */
async function composeBuildPlan(
  db: BuildPlanDb,
  cipher: SecretCipher | undefined,
  plan: { builderAgentId: string; planSetId: string; number: number; ticket: number | undefined },
  documents: Array<{
    id: string;
    path: string;
    kind: "document" | "design";
    version: { id: string; number: number; format: string; markdown: string | null };
  }>,
): Promise<BuildPlan> {
  if (!cipher) throw new PlanRefusedError("plan_not_approved", "secret values unavailable");
  let secrets: string[];
  try {
    // JSON- and HTML-escaped forms too: a design's manifest is JSON and its boards are HTML.
    const values = (await loadAgentSecretValues(db, cipher, plan.builderAgentId)).flatMap((e) => e.values);
    secrets = withHtmlEscapedForms(values);
  } catch {
    throw new PlanRefusedError("plan_not_approved", "secret values unavailable");
  }
  const redact = (text: string) => redactExactSecretValues(text, secrets);

  const entries = documents.map((d) => ({ id: d.id, path: d.path, kind: d.kind }));
  const sections: string[] = [];
  const planInputFiles: PlanFile[] = [];
  for (const doc of documents) {
    const content = await loadContent(db, doc.version);
    if (content.format === "markdown") {
      const redacted = redact(content.markdown);
      // R14: the file itself, so every rewritten link names a file the builder can open.
      planInputFiles.push({ path: doc.path, content: redacted });
      sections.push(
        `--- ${doc.path} (approved v${doc.version.number}) ---\n${rewriteLinksForBuilder(redacted, entries, doc.path)}`,
      );
    } else {
      for (const [inner, text] of Object.entries(content.files)) {
        planInputFiles.push({ path: `${doc.path}${inner}`, content: redact(text) });
      }
    }
  }
  try {
    assertPlanFilesWithinLimits(planInputFiles);
  } catch (err) {
    if (err instanceof Error && err.message === "plan_too_large") {
      throw new PlanRefusedError("plan_too_large", "the approved plan exceeds the plan limits");
    }
    throw err;
  }
  const scope =
    plan.ticket !== undefined
      ? `Build exactly ticket ${plan.ticket} from this approved plan.`
      : "Build exactly what the request asks (for example ticket 2) from this approved plan.";
  const taskSection = [
    `Approved plan ${plan.number}. ${scope} Do not widen the scope.`,
    `Every approved document is also a file in ${PLAN_FOLDER_PATH}/ (designs as their board folders).`,
    wrapUntrusted("plan", sections.join("\n\n")),
  ].join("\n");
  // R9: the section is stored in the request and never cut; a plan that cannot fit is refused.
  if (byteLength(taskSection) > MAX_CODING_TASK_BYTES / 2) {
    throw new PlanRefusedError("plan_too_large", "the approved plan does not fit the coding task limit");
  }
  return {
    planSetId: plan.planSetId,
    number: plan.number,
    versions: documents.map((d) => ({
      documentId: d.id,
      path: d.path,
      kind: d.kind,
      versionNumber: d.version.number,
    })),
    taskSection,
    planInputFiles,
  };
}

/** CodingRun.planVersions as stored (JSON); null when absent or not in the shape resolveBuildPlan writes. */
export function readPlanVersions(value: unknown): BuildPlan["versions"] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const versions: BuildPlan["versions"] = [];
  for (const v of value as unknown[]) {
    if (typeof v !== "object" || v === null) return null;
    const { documentId, path, kind, versionNumber } = v as Record<string, unknown>;
    if (
      typeof documentId !== "string" ||
      typeof path !== "string" ||
      (kind !== "document" && kind !== "design") ||
      typeof versionNumber !== "number" ||
      !Number.isSafeInteger(versionNumber)
    ) {
      return null;
    }
    versions.push({ documentId, path, kind, versionNumber });
  }
  return versions;
}

/** The PR body's line: names and version numbers only, e.g. "Plan 12: plan.md v3, screens v2". */
export function planPullRequestLine(number: number, versions: BuildPlan["versions"]): string {
  return `Plan ${number}: ${versions.map((v) => `${v.path.replace(/\/$/, "")} v${v.versionNumber}`).join(", ")}`;
}

/** Ticket number -> title, from `plan.md`'s `## Tickets` section (`### Ticket <t>: <title>` headings). */
export function ticketTitles(planMarkdown: string): Map<number, string> {
  const out = new Map<number, string>();
  let inTickets = false;
  for (const line of planMarkdown.split("\n")) {
    if (/^##\s+/.test(line)) {
      inTickets = /^##\s+Tickets\s*$/i.test(line);
      continue;
    }
    const ticket = inTickets ? /^###\s+Ticket\s+(\d{1,4})\s*:\s*(.+?)\s*$/i.exec(line) : null;
    if (ticket) out.set(Number(ticket[1]), ticket[2].slice(0, 200));
  }
  return out;
}
