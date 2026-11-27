/**
 * Building from an approved plan (docs/private spec §7). A coding agent with `buildFromPlan` builds
 * from the plan set for its repository and number made by a planner its owner can execute; a set
 * any counted document of which is not approved refuses the run before it starts. The approved
 * versions go to the builder twice: the Markdown as an untrusted section of the stored request (R9,
 * never cut), and every document as files in the plan folder (R14), so the rewritten links name files
 * that exist. A plan too large for the request whole gets a compact section instead: the approved
 * versions, a pointer to the plan folder, and the ticket's own section of plan.md (compactTaskSection). All of it is redacted by exact value against the builder's secret values at send time;
 * without them the gate refuses rather than pass unchecked text. Errors name documents by path only.
 */
import type { PrismaClient } from "#prisma";
import { byteLength, MAX_CODING_TASK_BYTES, PLAN_FOLDER_PATH } from "../../coding/protocol.js";
import { normalizeHostedRepository } from "../../coding/code-host.js";
import { assertPlanFilesWithinLimits, type PlanFile } from "../../coding/plan-files/store.js";
import { withHtmlEscapedForms } from "../documents/formats/boards.js";
import { atLeast, effectiveAccess } from "../grants.js";
import { loadAgentSecretValues } from "../secret-guard.js";
import { redactExactSecretValues } from "../secret-spans.js";
import { wrapUntrusted } from "../untrusted-content.js";
import { rewriteLinksForBuilder } from "./links.js";
import { versionPlanFiles } from "./revision.js";
import type { SecretCipher } from "./publish.js";
import { PlanRefusedError } from "./refusal.js";
import { defuseNotice, shownPlanPath } from "./wording.js";

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
 * The visibility rule of a builder's plan lookup: of the sets sharing a repository and number (newest
 * first), the first whose planner the builder's owner can execute. A builder never pulls in a plan its
 * owner cannot see. Shared by the build gate (resolveBuildPlan) and the `build ticket <t>` command
 * (approval.ts), so both always pick the same set.
 */
export async function newestVisiblePlanSet<T extends { agent: { id: string; ownerId: string | null } }>(
  db: Pick<PrismaClient, "resourceGrant">,
  newestFirst: readonly T[],
  builderOwnerId: string,
): Promise<T | undefined> {
  for (const candidate of newestFirst) {
    const access = await effectiveAccess(db, "agent", candidate.agent, builderOwnerId);
    if (atLeast("agent", access, "execute")) return candidate;
  }
  return undefined;
}

const documentCount = (n: number) => `${n} ${n === 1 ? "document" : "documents"}`;

/**
 * Plan paths for a refusal (its message reaches the requester: an issue reply, a tool result, a
 * refused run's error), redacted by exact value against the planner's secret values. Null when those
 * can't be read: the refusal then gives a count instead of any path.
 */
async function plannerRedactedPaths(
  db: BuildPlanDb,
  cipher: SecretCipher | undefined,
  plannerAgentId: string,
  paths: readonly string[],
): Promise<string[] | null> {
  if (!cipher) return null;
  try {
    const values = (await loadAgentSecretValues(db, cipher, plannerAgentId)).flatMap((e) => e.values);
    return paths.map((path) => redactExactSecretValues(path, values));
  } catch {
    return null;
  }
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
  const set = await newestVisiblePlanSet(db, sets, input.builderOwnerId);
  if (!set) return null;

  const documents = [...set.documents].sort(byPlanOrder);
  const waiting = documents.filter((d) => d.reviewState !== "approved" || !d.currentVersion).map((d) => d.planPath!);
  if (waiting.length > 0) {
    const shown = await plannerRedactedPaths(db, cipher, set.agent.id, waiting);
    throw new PlanRefusedError(
      "plan_not_approved",
      `still waiting: ${shown ? shown.join(", ") : documentCount(waiting.length)}`,
      shown ?? [],
    );
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
    const planner = await db.planSet.findUnique({ where: { id: input.planSetId }, select: { agentId: true } });
    const shown = planner ? await plannerRedactedPaths(db, cipher, planner.agentId, missing) : null;
    throw new PlanRefusedError(
      "plan_not_approved",
      `approved version no longer available: ${shown ? shown.join(", ") : documentCount(missing.length)}`,
    );
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
  // plan.md as given to the builder (redacted, links rewritten): the source of a ticket's own section.
  let planText: string | null = null;
  for (const doc of documents) {
    // R14: the files themselves, so every rewritten link names a file the builder can open.
    const { files, markdown } = await versionPlanFiles(db, doc.path, doc.version, redact);
    planInputFiles.push(...files);
    if (markdown !== null) {
      const rewritten = rewriteLinksForBuilder(markdown, entries, doc.path);
      if (doc.path === "plan.md") planText = rewritten;
      sections.push(`--- ${doc.path} (approved v${doc.version.number}) ---\n${rewritten}`);
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
  const versions = documents.map((d) => ({
    documentId: d.id,
    path: d.path,
    kind: d.kind,
    versionNumber: d.version.number,
  }));
  const header = `Approved plan ${plan.number}. ${scope} Do not widen the scope.`;
  const fits = (section: string) => byteLength(section) <= MAX_CODING_TASK_BYTES / 2;
  // R9: what goes in the stored request is never cut. A plan that fits goes in whole.
  const whole = [
    header,
    `Every approved document is also a file in ${PLAN_FOLDER_PATH}/ (designs as their board folders).`,
    wrapUntrusted("plan", sections.join("\n\n")),
  ].join("\n");
  let taskSection = fits(whole) ? whole : compactTaskSection(header, versions, planText, plan.ticket);
  // With no ticket, the text before Tickets is a convenience: drop it rather than refuse the build.
  if (!fits(taskSection) && plan.ticket === undefined) {
    taskSection = compactTaskSection(header, versions, null, undefined);
  }
  if (!fits(taskSection)) {
    throw new PlanRefusedError(
      "plan_too_large",
      plan.ticket !== undefined
        ? `ticket ${plan.ticket} of the approved plan does not fit the coding task limit`
        : "the approved plan does not fit the coding task limit",
    );
  }
  return { planSetId: plan.planSetId, number: plan.number, versions, taskSection, planInputFiles };
}

/**
 * The task section for a plan too large to inline whole (R9 still holds: nothing in it is cut). It
 * names the approved versions and points at the plan folder, which holds every document in full
 * (R14), and inlines what the run builds: the ticket's own `### Ticket <t>:` section of plan.md, or,
 * with no ticket, plan.md's text before `## Tickets`. Without plan.md or a matching section it inlines
 * nothing more; the builder reads the files.
 */
function compactTaskSection(
  header: string,
  versions: BuildPlan["versions"],
  planText: string | null,
  ticket: number | undefined,
): string {
  const listed = versions.map((v) => `${shownPlanPath(v.path)} v${v.versionNumber}`).join(", ");
  const lines = [
    header,
    `The approved plan is too large to include here. Its documents (${listed}) are files in ${PLAN_FOLDER_PATH}/ (designs as their board folders): read ${PLAN_FOLDER_PATH}/plan.md first, then the documents it links.`,
  ];
  const part =
    planText === null ? null : ticket !== undefined ? ticketSection(planText, ticket) : beforeTickets(planText);
  if (part) {
    lines.push(
      ticket !== undefined
        ? `Ticket ${ticket} as approved in plan.md:`
        : "plan.md as approved, up to its Tickets section:",
      wrapUntrusted("plan", part),
    );
  }
  return lines.join("\n");
}

/** plan.md's `### Ticket <t>:` section under `## Tickets`, up to the next `###` or `##` heading; null when absent. */
export function ticketSection(planMarkdown: string, ticket: number): string | null {
  const out: string[] = [];
  let inTickets = false;
  let inTicket = false;
  for (const line of planMarkdown.split("\n")) {
    if (/^##\s+/.test(line)) {
      if (inTicket) break;
      inTickets = /^##\s+Tickets\s*$/i.test(line);
      continue;
    }
    const heading = inTickets ? /^###\s+Ticket\s+(\d{1,4})\s*:/i.exec(line) : null;
    if (heading || (inTicket && /^###\s+/.test(line))) {
      if (inTicket) break;
      inTicket = heading !== null && Number(heading[1]) === ticket;
    }
    if (inTicket) out.push(line);
  }
  const text = out.join("\n").trimEnd();
  return text === "" ? null : text;
}

/** plan.md's text before its `## Tickets` heading (all of it when there is none); null when empty. */
function beforeTickets(planMarkdown: string): string | null {
  const at = planMarkdown.search(/^##\s+Tickets\s*$/im);
  const text = (at === -1 ? planMarkdown : planMarkdown.slice(0, at)).trimEnd();
  return text === "" ? null : text;
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
  // Paths shown as in a notice: a path's @-mention pings nobody, its URL autolinks nowhere.
  return defuseNotice(
    `Plan ${number}: ${versions.map((v) => `${shownPlanPath(v.path)} v${v.versionNumber}`).join(", ")}`,
  );
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
