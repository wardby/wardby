/**
 * The admin viewer API's contract (docs/viewer-api.md). Every response and
 * live event the API sends is defined here; build-schemas.ts publishes them as
 * JSON Schema under src/viewer/schemas/, which the viewer app generates its
 * types from (it never imports server source). Change a shape here, run
 * `npm run build:viewer-schemas`, and commit the regenerated files.
 */
import { z } from "zod";

export const RunStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "refused",
  "lost",
  "budget_exhausted",
  "cancelled",
]);

/** What started a run, resolved for display. A sub-agent run's cause is its parent (parentRunId). */
export const RunTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual") }),
  z.object({ kind: z.literal("scheduled"), schedule: z.string().nullable() }),
  z.object({ kind: z.literal("webhook") }),
  z.object({ kind: z.literal("subagent") }),
  z.object({
    kind: z.literal("code_host"),
    provider: z.string(),
    repository: z.string(),
    number: z.number().int().nullable(),
    event: z.enum(["review", "mention"]),
  }),
  /** `url`: the issue's page on the tracker, or null when the server has no site configured for it. */
  z.object({ kind: z.literal("issue"), provider: z.string(), issueKey: z.string(), url: z.string().nullable() }),
  z.object({ kind: z.literal("host_event") }),
]);

/** When the outcome happened (PR opened, comment last updated, check completed); null while a check is pending. */
const OutcomeAtSchema = z.string().nullable();

export const OutcomeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("pull_request"),
    provider: z.string(),
    repository: z.string(),
    number: z.number().int(),
    url: z.string(),
    state: z.string().nullable(),
    at: OutcomeAtSchema,
  }),
  z.object({
    kind: z.literal("code_host_comment"),
    provider: z.string(),
    repository: z.string(),
    number: z.number().int(),
    at: OutcomeAtSchema,
  }),
  /** `url` opens the issue at wardby's comment, or null when the server has no site configured for it. */
  z.object({
    kind: z.literal("issue_comment"),
    provider: z.string(),
    issueKey: z.string(),
    url: z.string().nullable(),
    at: OutcomeAtSchema,
  }),
  z.object({
    kind: z.literal("check"),
    provider: z.string(),
    repository: z.string(),
    number: z.number().int().nullable(),
    completed: z.boolean(),
    at: OutcomeAtSchema,
  }),
]);

export const ServiceStatusSchema = z.object({
  name: z.string(),
  state: z.enum(["pending", "probing", "ready", "failed"]),
  attempts: z.number().int().nullable(),
  reason: z.string().nullable(),
  readyAt: z.string().nullable(),
  failedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const GraphRunSchema = z.object({
  id: z.string(),
  parentRunId: z.string().nullable(),
  agentId: z.string(),
  agentName: z.string(),
  agentKind: z.enum(["native", "coding"]),
  /** The coding run's model, else the agent's. */
  model: z.string(),
  /** The coding worker (e.g. `codex`, `claude-code`); null for native runs. */
  codingProvider: z.string().nullable(),
  /** Where a native run executed, snapshotted at start; null for coding runs and runs from before the field existed. */
  nativeExecutionMode: z.enum(["control-plane", "sandbox"]).nullable(),
  /** The warm pool worker (container or pod name) a sandbox run claimed, while its record lasts; null otherwise. */
  warmWorkerName: z.string().nullable(),
  status: RunStatusSchema,
  trigger: RunTriggerSchema,
  turns: z.number().int(),
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  costUsd: z.number(),
  budgetUsd: z.number(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  heartbeatAt: z.string().nullable(),
  outcomes: z.array(OutcomeSchema),
  /** The services a coding run was started with, recorded or not; empty for native runs. */
  declaredServices: z.array(z.object({ name: z.string(), version: z.string() })),
  /** Recorded readiness of the run's services (none before status tracking existed). */
  services: z.array(ServiceStatusSchema),
});

export const BudgetGroupSpendSchema = z.object({
  id: z.string(),
  name: z.string(),
  dailyBudgetUsd: z.number().nullable(),
  spentTodayUsd: z.number(),
});

export const GraphSnapshotSchema = z.object({
  generatedAt: z.string(),
  since: z.string(),
  limit: z.number().int(),
  truncated: z.boolean(),
  runs: z.array(GraphRunSchema),
  spend: z.object({ todayUsd: z.number(), groups: z.array(BudgetGroupSpendSchema) }),
});

export const RunDetailSchema = GraphRunSchema.extend({
  error: z.string().nullable(),
  finalText: z.string().nullable(),
  childRunIds: z.array(z.string()),
  coding: z
    .object({
      provider: z.string(),
      repository: z.string(),
      baseRef: z.string(),
      headRef: z.string(),
      queuedAt: z.string().nullable(),
      failureCategory: z.string().nullable(),
      services: z.array(
        z.object({
          name: z.string(),
          version: z.string(),
          image: z.string(),
          envNames: z.array(z.string()),
        }),
      ),
    })
    .nullable(),
});

export const ViewerEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("run"),
    runId: z.string(),
    parentRunId: z.string().nullable(),
    agentId: z.string(),
    status: RunStatusSchema,
    turns: z.number().int(),
    tokensIn: z.number().int(),
    tokensOut: z.number().int(),
    costUsd: z.number(),
    finishedAt: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("service"),
    runId: z.string(),
    name: z.string(),
    state: z.enum(["pending", "probing", "ready", "failed"]),
    attempts: z.number().int().nullable(),
  }),
  z.object({
    kind: z.literal("outcome"),
    runId: z.string(),
    /** Which table changed (the viewer NOTIFY trigger names them). */
    source: z.enum(["pull_request", "host_status", "issue_status", "host_check"]),
  }),
]);

export type RunTriggerInfo = z.infer<typeof RunTriggerSchema>;
export type Outcome = z.infer<typeof OutcomeSchema>;
export type ServiceStatus = z.infer<typeof ServiceStatusSchema>;
export type GraphRun = z.infer<typeof GraphRunSchema>;
export type GraphSnapshot = z.infer<typeof GraphSnapshotSchema>;
export type RunDetail = z.infer<typeof RunDetailSchema>;
export type ViewerEvent = z.infer<typeof ViewerEventSchema>;

/** How this deployment runs coding jobs, for the desktop viewer's Infrastructure view (GET /admin/api/infra). */
export const InfraInfoSchema = z.object({
  launcher: z.enum(["local", "docker", "kubernetes"]),
  kubernetes: z
    .object({
      namespace: z.string(),
      platform: z.string(),
      runtimeClass: z.string().nullable(),
      proxyService: z.string(),
      runLabel: z.string(),
      runLabelHashChars: z.number().int(),
      componentLabel: z.record(z.string(), z.string()),
      managedByLabel: z.record(z.string(), z.string()),
    })
    .nullable(),
  /** How sandbox-mode native agents run; null when NATIVE_SANDBOX_LAUNCHER is unset. */
  native: z
    .object({
      launcher: z.enum(["docker", "kubernetes"]),
      /** Idle workers kept ready for runs to claim (0 = no pool). */
      warmPoolSize: z.number().int(),
      kubernetes: z
        .object({
          namespace: z.string(),
          runtimeClass: z.string().nullable(),
          runLabel: z.string(),
          componentLabel: z.record(z.string(), z.string()),
          warmPoolLabel: z.record(z.string(), z.string()),
          warmWorkerLabel: z.string(),
        })
        .nullable(),
    })
    .nullable(),
});
export type InfraInfo = z.infer<typeof InfraInfoSchema>;

export const VIEWER_SCHEMAS = {
  "graph-snapshot": GraphSnapshotSchema,
  "run-detail": RunDetailSchema,
  "viewer-event": ViewerEventSchema,
  "infra-info": InfraInfoSchema,
} as const;
