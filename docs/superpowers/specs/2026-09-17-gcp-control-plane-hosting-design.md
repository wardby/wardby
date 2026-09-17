# GCP Control-Plane Hosting (Cloud Run + Cloud SQL + DBOS) — Design

**Date:** 2026-09-17
**Status:** Proposed (design; implementation plan to follow via writing-plans)
**Author:** reevo-run maintainer
**Related:** `docs/private/2026-09-05-roadmap-mcp-native.md` (Phase 12 — GCP
deployment, the informal-numbering "Phase 7+" this design fleshes out);
`docs/private/2026-09-13-http-reachable-service-plan.md` (the ngrok plan
this design supersedes — see §6); `docs/phase-7-production-readiness.md`
(cloud-agnostic production hardening, in progress on a separate branch —
this design does not duplicate it); `src/providers/executor/dbos.ts`
(`DbosExecutor`, the process-singleton/executor-id constraints this design
satisfies); `src/config/providers.ts` (`loadDbosConfig`, `DbosConfig`).

> **Clean-room note.** Grounded in reevo-run's own code (`dbos.ts`,
> `providers.ts`, `schema.prisma`'s `SchedulerLease`) plus Google Cloud's own
> published documentation (Cloud Run, Cloud SQL, the metadata server),
> fetched and quoted directly in this session rather than recalled from
> training data. Copies no external codebase.

---

## Goal

Reevo-run currently has no cloud hosting story at all — the always-on
control plane (MCP server + scheduler +, when `EXECUTOR=dbos`, the DBOS
durable-workflow engine) only runs locally or via ad hoc deployment. This
design specifies the first real cloud target: **GCP, with Terraform as the
infrastructure-as-code baseline for every reevo-run cloud deployment, not
just this one.** `deploy/gcp/` is meant to be the reference example future
targets (AWS, the still-empty `deploy/aws/` placeholder) follow.

This is sub-project 1 of a larger "move to GCP" effort, decomposed in
conversation before this spec was written. It covers **only** the
always-on control-plane hosting and its database — where the MCP
server/scheduler/DBOS process runs, and where Postgres lives. It
deliberately does not cover the pieces listed in Non-goals below; those are
separate spec cycles.

## Non-goals

- **The coding-worker `JobLauncher`.** The roadmap's Phase 12 sketch of
  Cloud Run *Jobs* replacing local Docker for Phase 5's containerized
  coding-agent runs is a separate, mostly-independent sub-project. Nothing
  in this design blocks it — it will consume the control plane this design
  builds — but its own Terraform (VPC connector, firewall rules for the
  coding-proxy's egress lockdown, the `JobLauncher` adapter code) is out of
  scope here.
- **CI/CD deploy pipeline.** How new container images get built and rolled
  out to the Cloud Run service is not designed here. `deploy/gcp/` describes
  the infrastructure a pipeline would deploy *to*, not the pipeline itself.
- **Cloud Monitoring/Logging migration.** The existing local
  Prometheus/Grafana stack (`deploy/observability/`) is untouched; whether
  and how to add Cloud-native observability is future work.
- **Phase 7's own scope** (CI hardening, dependency scanning, generic
  production readiness) — in progress separately on
  `codex/phase7-ci-consolidation`. This design cross-references Phase 7
  where relevant (secrets, TLS) but does not duplicate or block it.
- **A live GCP project.** This design and its Terraform are usable against
  any GCP project the operator provides via variables; no specific project
  id, domain, or account is assumed or hardcoded anywhere in the module.

---

## 1. Compute: Cloud Run service, `min_instance_count` defaults to 2

The control plane runs as a `google_cloud_run_v2_service`, not Cloud Run
Jobs (Jobs are run-to-completion; the MCP server and scheduler are
long-running). Per §4's reusability requirement, instance counts are
variables rather than fixed in `cloud-run.tf`:

```hcl
variable "min_instance_count" {
  description = "Minimum Cloud Run replicas. 2+ avoids a scale-to-zero gap in scheduler availability and a single point of failure across restarts/deploys."
  type        = number
  default     = 2
}

variable "max_instance_count" {
  type    = number
  default = 10
}
```

The default of 2 is this deployment's own deliberate HA choice, made
explicit in conversation while designing this; a copy of this module is
free to set it to 1 for a cheaper/dev deployment.

Running multiple concurrent replicas is already safe with the existing
code, verified in this session, not assumed:
- **Scheduler correctness:** `SchedulerLease` (`prisma/schema.prisma`) is a
  single-row-per-scope lease that already ensures exactly one replica's
  scheduler tick claims a given cron fire.
- **Workflow correctness:** DBOS's `workflowID: runId` idempotency (see
  `DbosExecutor.start`'s comment in `dbos.ts`) means a second replica
  attaching to a run already started elsewhere joins the same workflow
  rather than duplicating it, and `recover()`'s adoption logic is already
  designed for multiple executor ids coexisting and adopting each other's
  orphaned work.

**Each replica needs its own `DBOS_EXECUTOR_ID`** — `DbosExecutor`'s
constructor (`dbos.ts`) refuses to construct without one, deliberately
(no default, so two processes never silently share an identity). See §2 for
how each replica gets a distinct one automatically.

## 2. `DBOS_EXECUTOR_ID` sourced from the Cloud Run metadata server

Verified against Google's own docs in this session (not assumed): every
Cloud Run instance (service or job) can reach
`http://metadata.google.internal/computeMetadata/v1/instance/id` with a
`Metadata-Flavor: Google` header, and it returns a numeric ID unique to that
running instance — auto-generated by GCP, not something the operator sets.

**New file `src/config/gcp-metadata.ts`:**

```typescript
/** Fetches the running instance's unique GCP-assigned id from the metadata
 * server, or undefined if unreachable (non-GCP environment, local dev, or
 * any network/timeout failure) — callers fall back to an explicit env var.
 * `Metadata-Flavor: Google` is required by GCP to protect against SSRF from
 * code that doesn't expect to be reaching this host. */
export async function fetchGcpInstanceId(timeoutMs = 2_000): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/id",
      { headers: { "Metadata-Flavor": "Google" }, signal: controller.signal },
    );
    if (!res.ok) return undefined;
    return (await res.text()).trim() || undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
```

`src/config/providers.ts`'s `loadDbosConfig` (currently synchronous, reading
only `env.DBOS_EXECUTOR_ID`) becomes:

```typescript
export async function loadDbosConfig(env: NodeJS.ProcessEnv = process.env): Promise<DbosConfig> {
  return {
    systemDatabaseUrl: env.DBOS_SYSTEM_DATABASE_URL ?? env.DATABASE_URL,
    schemaName: env.DBOS_SCHEMA ?? "dbos",
    executorId: env.DBOS_EXECUTOR_ID ?? (await fetchGcpInstanceId()),
  };
}
```

Its one existing caller, `buildExecutor` in
`src/providers/executor/build.ts:20`, becomes `async` to `await` it —
verified to be this function's only call site in `src/`, so this is a
contained, single-path change, not a wide ripple. An explicit
`DBOS_EXECUTOR_ID` env var (local dev, non-GCP hosts, the scheduler and MCP
server needing visibly-different fixed ids in a small deployment) always
wins over the metadata fetch.

## 3. Database: one Cloud SQL instance, two schemas, HA tier as a variable

A single `google_sql_database_instance` (Postgres) hosts both the app's own
tables (default/`public` schema, Prisma-managed) and DBOS's system tables
(the `dbos` schema — the same `schemaName` convention local dev already
uses, `DBOS_SCHEMA` from `loadDbosConfig` above). One instance, one
connection secret, one backup/HA policy covers both — matching the existing
local-dev assumption that DBOS's tables live alongside the app's in the same
database, just a different schema.

**HA tier is a Terraform variable, not a fixed choice** — per your
instruction that people using this module need to choose, not inherit a
hardcoded decision:

```hcl
variable "cloudsql_availability_type" {
  description = "Cloud SQL availability: \"ZONAL\" (single zone, cheaper) or \"REGIONAL\" (synchronous standby + automatic failover, ~2x cost)."
  type        = string
  default     = "ZONAL"
  validation {
    condition     = contains(["ZONAL", "REGIONAL"], var.cloudsql_availability_type)
    error_message = "cloudsql_availability_type must be \"ZONAL\" or \"REGIONAL\"."
  }
}
```

Cloud Run connects to Cloud SQL via Cloud Run's built-in Cloud SQL
connection (a Unix-socket volume mount using the instance's connection
name) — no VPC connector needed for this piece; that machinery is reserved
for the coding-proxy egress-lockdown sub-project (Non-goals).

## 4. Reusability: copy-or-parameterize, no hardcoded identity

Every project-specific value is a variable with no default tied to this
project — `project_id`, `region`, `domain_name` have no default at all
(Terraform requires them explicitly); a `name_prefix` variable (default
`"reevo-run"`, but override-able) is used in every resource name so a
second copy deployed under a different prefix in the same or another
project never collides. `deploy/gcp/terraform.tfvars.example` documents
both usage patterns explicitly: fork the whole folder and edit in place, or
keep it as-is and supply your own `terraform.tfvars`. The Terraform state
backend (`backend "gcs" { ... }` or otherwise) is **not** hardcoded in
`versions.tf` — `deploy/README.md`'s GCP section documents configuring it
per-deployment, since a baked-in bucket name is exactly the kind of
project-specific identity this module must not assume.

## 5. Security posture

- **Custom, least-privilege service account** for the Cloud Run service
  (`service-accounts.tf`) — not the broad-scope default compute service
  account. Directly addresses the SSRF/metadata-token-theft risk class
  discussed while designing this (a compromised broad-scope default SA
  turns any SSRF bug into full project access; a scoped custom SA bounds
  the blast radius to exactly what reevo needs).
- **Secret Manager** (`secrets.tf`) for the Cloud SQL connection string and
  VCS/LLM credential refs, granted to that service account only via IAM,
  not baked into the container image or Terraform state as plaintext.
- Ingress is HTTPS-only by Cloud Run's own design (TLS terminated at
  Google's front end); whether to require authenticated invocation
  (`run.routes.invoke`) beyond MCP's own OAuth layer is a Phase 7 /
  rollout-time decision, not fixed by this design.

## 6. Ingress: custom domain, retiring the ngrok plan

`domain.tf` provisions a `google_cloud_run_domain_mapping` for an
operator-supplied domain (`var.domain_name`), which becomes the MCP
server's stable `canonicalUri`/`AUTH_AUDIENCE` — the identity MCP's OAuth
resource metadata needs to stay byte-identical over time. This fully
replaces `docs/private/2026-09-13-http-reachable-service-plan.md`'s
ngrok-based approach: that plan's entire motivation (a stable public HTTPS
endpoint) is satisfied natively by Cloud Run once this ships. The ngrok
plan's own roadmap entry should be marked superseded once this design is
approved.

## 7. File structure

```
deploy/
  README.md                    # updated: gcp/ section, both usage patterns
  gcp/
    versions.tf                # provider requirements, pinned; no backend block
    variables.tf                # project_id, region, name_prefix, domain_name,
                                 # cloudsql_availability_type, min/max instances
    cloudsql.tf                # google_sql_database_instance + two google_sql_database
    service-accounts.tf        # custom least-privilege SA for Cloud Run
    secrets.tf                 # Secret Manager entries + IAM bindings
    cloud-run.tf                # google_cloud_run_v2_service, min/max instance count from variables
    domain.tf                  # google_cloud_run_domain_mapping
    outputs.tf                 # service URL, Cloud SQL connection name, etc.
    terraform.tfvars.example    # documents both copy-it and parameterize-it usage
```

Each file has one resource area's responsibility, matching this project's
existing convention of small, focused files over one large one.

## 8. Testing

- **Terraform:** `terraform validate` and `terraform fmt -check` are real,
  deterministic checks addable to CI now. `terraform plan` requires real
  GCP credentials and a real (even if throwaway) project, so it is **not**
  automated in CI by this design — that's a rollout-time decision for
  whoever runs it, not something to script blind against a live cloud
  account.
- **`fetchGcpInstanceId`:** a real unit test mocking `fetch` (the global,
  already used elsewhere in this codebase's Node runtime) — one case
  returning a 200 with a body, one case simulating a timeout/network
  failure, asserting `undefined` in the failure case so the `??` fallback
  in `loadDbosConfig` is provably exercised.
- **`loadDbosConfig`:** existing tests (if any) that construct it need
  updating to `await` it now that it's async; new test asserting the env
  var wins over a (mocked) metadata fetch when both are present.

## Rollout order

1. Add `src/config/gcp-metadata.ts` + make `loadDbosConfig`/`buildExecutor`
   async, with tests. Lands independently of any Terraform — safe to ship
   even before a GCP project exists, since the fallback preserves today's
   behavior everywhere else.
2. Write the Terraform module (`deploy/gcp/`), `terraform validate`-clean,
   against a throwaway/sandbox GCP project to prove it actually applies.
3. Update `deploy/README.md`'s `gcp/` section from "not yet built" to real
   usage instructions.
4. Mark the ngrok plan (`docs/private/2026-09-13-http-reachable-service-plan.md`)
   superseded in the roadmap.
