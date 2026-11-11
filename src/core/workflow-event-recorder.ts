/**
 * Turns an emitted workflow event into outbox rows: resolves the event's work
 * item (given, else the run's attribution, else the PR's issue link), finds
 * the channel links that match (project links by the item's project, agent
 * links by the event's agent), filters each link's event kinds, de-duplicates
 * by channel, and writes one WorkflowEvent plus one NotificationDelivery per
 * channel in a transaction. The same transaction writes one RunHookDelivery
 * per run hook on the event's agent that takes the event (hookWants), so Slack
 * and run hooks share one event stream. Channels never take run_completed.
 * A dedupeKey that already exists is a no-op, so redeliveries and repeated
 * finalizers record a fact once. Writes nothing when no link or hook matches.
 */
import { Prisma, type PrismaClient } from "#prisma";
import { projectOf } from "../providers/issue-tracker/types.js";
import { hookWants } from "./run-hooks/match.js";
import { threadKeys, type WorkflowEventInput, type WorkflowEventSink } from "./workflow-events.js";

export type RecorderDb = Pick<
  PrismaClient,
  | "notificationChannel"
  | "workflowEvent"
  | "notificationDelivery"
  | "runAttribution"
  | "issuePullRequest"
  | "runHook"
  | "runHookDelivery"
  | "$transaction"
>;

/** The channel deliveries an event gets: none for run_completed or without a chat provider. */
async function matchChannels(
  db: RecorderDb,
  input: WorkflowEventInput,
  item: { provider: string; key: string } | null,
  enabledProviders: readonly string[],
): Promise<{ provider: string; channelId: string; includeCost: boolean }[]> {
  if (enabledProviders.length === 0 || input.payload.kind === "run_completed") return [];
  const or: Prisma.NotificationChannelWhereInput[] = [];
  if (item) or.push({ issueProvider: item.provider, projectKey: projectOf(item.key) });
  if (input.agentId) or.push({ agentId: input.agentId });
  if (or.length === 0) return [];
  const links = await db.notificationChannel.findMany({
    where: { provider: { in: [...enabledProviders] }, OR: or },
    select: { provider: true, channelId: true, events: true, includeCost: true },
  });
  const kind = input.payload.kind;
  const byChannel = new Map<string, { provider: string; channelId: string; includeCost: boolean }>();
  for (const link of links) {
    if (link.events.length > 0 && !link.events.includes(kind)) continue;
    const key = `${link.provider}\u0000${link.channelId}`;
    const prev = byChannel.get(key);
    byChannel.set(key, {
      provider: link.provider,
      channelId: link.channelId,
      includeCost: (prev?.includeCost ?? false) || link.includeCost,
    });
  }
  return [...byChannel.values()];
}

/** The enabled run hooks on the event's agent that take it. */
async function matchHooks(db: RecorderDb, input: WorkflowEventInput): Promise<string[]> {
  if (!input.agentId) return [];
  const hooks = await db.runHook.findMany({
    where: { agentId: input.agentId, enabled: true },
    select: { id: true, events: true, statuses: true, runs: true },
  });
  const payload = input.payload as { kind: string; status?: unknown; parentRunId?: unknown };
  return hooks.filter((h) => hookWants(h, payload.kind, payload)).map((h) => h.id);
}

async function resolveWorkItem(
  db: RecorderDb,
  input: WorkflowEventInput,
): Promise<{ provider: string; key: string } | null> {
  if (input.workItem) return input.workItem;
  if (input.runId) {
    const attribution = await db.runAttribution.findUnique({
      where: { runId: input.runId },
      select: { workItem: { select: { provider: true, key: true } } },
    });
    if (attribution) return attribution.workItem;
  }
  if (input.pullRequest) {
    const pr = await db.issuePullRequest.findFirst({
      where: {
        codeProvider: input.pullRequest.codeProvider,
        repository: input.pullRequest.repository,
        number: input.pullRequest.number,
      },
      orderBy: { createdAt: "asc" },
      select: { issueProvider: true, issueKey: true },
    });
    if (pr) return { provider: pr.issueProvider, key: pr.issueKey };
  }
  return null;
}

export function createWorkflowEventRecorder(db: RecorderDb, enabledProviders: readonly string[]): WorkflowEventSink {
  return async (input) => {
    // Without a chat provider only an agent's run hooks can take the event:
    // look for them first, so an event no hook takes costs one query.
    const noChat = enabledProviders.length === 0;
    if (noChat && !input.agentId) return;
    const hookIds = await matchHooks(db, input);
    if (noChat && hookIds.length === 0) return;
    const existing = await db.workflowEvent.findUnique({
      where: { dedupeKey: input.dedupeKey },
      select: { id: true },
    });
    if (existing) return;
    const item = await resolveWorkItem(db, input);
    const channels = await matchChannels(db, input, item, enabledProviders);
    const threadKey = item
      ? threadKeys.issue(item.provider, item.key)
      : input.pullRequest
        ? threadKeys.pr(input.pullRequest.codeProvider, input.pullRequest.repository, input.pullRequest.number)
        : input.runId
          ? threadKeys.run(input.runId)
          : null;
    // Channel deliveries need a thread; hook deliveries don't.
    const channelRows = threadKey ? channels : [];
    if (channelRows.length === 0 && hookIds.length === 0) return;
    const kind = input.payload.kind;
    try {
      await db.$transaction(async (tx) => {
        const event = await tx.workflowEvent.create({
          data: {
            kind,
            dedupeKey: input.dedupeKey,
            runId: input.runId ?? null,
            agentId: input.agentId ?? null,
            workItemProvider: item?.provider ?? null,
            workItemKey: item?.key ?? null,
            codeProvider: input.pullRequest?.codeProvider ?? null,
            repository: input.pullRequest?.repository ?? null,
            prNumber: input.pullRequest?.number ?? null,
            payload: input.payload,
          },
        });
        if (channelRows.length > 0 && threadKey) {
          await tx.notificationDelivery.createMany({
            data: channelRows.map((c) => ({
              eventId: event.id,
              provider: c.provider,
              channelId: c.channelId,
              threadKey,
              includeCost: c.includeCost,
            })),
          });
        }
        if (hookIds.length > 0) {
          await tx.runHookDelivery.createMany({ data: hookIds.map((hookId) => ({ eventId: event.id, hookId })) });
        }
      });
    } catch (err) {
      // A concurrent recording of the same fact won the dedupeKey: nothing to do.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return;
      throw err;
    }
  };
}
