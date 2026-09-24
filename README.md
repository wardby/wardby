<div>
  <img align="left" hspace="24" src="https://raw.githubusercontent.com/wardby/wardby/main/docs/assets/brand/wardby-mascot.png" alt="Wardby guardian robot protecting an agent budget" width="280">
  <h3><big><big>Wardby</big></big> <small><em>(pronounced&nbsp;“WARD&#8209;bee”)</em></small></h3>
  <h3>Autonomous agents, bounded by design.</h3>
  <p><strong>Most agent runners focus on helping a model complete a task. Wardby is the self-hosted control plane that decides whether the task should run, limits what it can access, and returns a reviewable outcome governed by explicit policy.</strong></p>
  <br clear="left">
  <p><strong>Budgets are enforced before spend: every model request must fit within a hard run limit before it reaches the provider.</strong></p>
  <p>
    <a href="#why-wardby">Why Wardby</a> ·
    <a href="#why-wardby-instead-of-another-agent-runner">Why it is different</a> ·
    <a href="#a-full-cycle-agent-from-one-conversation">Full-cycle example</a> ·
    <a href="#host-it-in-your-cloud">Deployments</a> ·
    <a href="#bring-your-own-observability">Observability</a> ·
    <a href="https://github.com/wardby/wardby/blob/main/docs/getting-started.md">Getting started</a> ·
    <a href="#security-boundaries">Security</a>
  </p>
</div>
<br clear="left">

<!-- The first four badges are live: the npm version, Node floor and license are
read from the published package, and the security badge shows the latest run of
the security workflow on main. The last three are capability labels describing
what that workflow enforces -- they are not status and never change colour.
Every URL is absolute because npm renders this README too, and a relative path
there resolves against npmjs.com instead of this repository. -->

[![npm](https://img.shields.io/npm/v/@wardby/cli)](https://www.npmjs.com/package/@wardby/cli)
[![Security checks](https://github.com/wardby/wardby/actions/workflows/security.yml/badge.svg?branch=main)](https://github.com/wardby/wardby/actions/workflows/security.yml?query=branch%3Amain)
[![Node](https://img.shields.io/node/v/@wardby/cli)](https://www.npmjs.com/package/@wardby/cli)
[![License](https://img.shields.io/npm/l/@wardby/cli)](https://github.com/wardby/wardby/blob/main/LICENSE)
[![Dependency audit](https://img.shields.io/badge/dependencies-audit%20policy-0f766e.svg)](https://github.com/wardby/wardby/actions/workflows/security.yml?query=branch%3Amain)
[![Container scan](https://img.shields.io/badge/container%20images-Trivy%20CRITICAL%20gate-0f766e.svg)](https://github.com/wardby/wardby/actions/workflows/security.yml?query=branch%3Amain)
[![SBOM](https://img.shields.io/badge/SBOM-SPDX%20JSON-0f766e.svg)](https://github.com/wardby/wardby/actions/workflows/security.yml?query=branch%3Amain)

> **Project status:** the control plane, scheduler, budget groups, MCP server,
> native agents, isolated Codex and Claude Code workers, GitHub draft-PR flow,
> and local observability stack are implemented and tested. Production
> readiness and cloud deployment coverage are still being expanded.

## Why Wardby

AI agents are easy to demo and harder to operate. Once an agent can spend
money, use credentials, change a repository, or run without a person watching,
teams need more than a prompt and a cron job.

Wardby provides the control plane around the model:

| For engineering leaders                                                     | For developers                                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Put explicit cost, ownership, and approval boundaries around agent work.    | Create and manage agents from Claude or Codex through MCP.                                 |
| Keep execution, data, and credentials in infrastructure your team controls. | Choose OpenAI, Anthropic, or Bedrock-backed models per agent.                              |
| Turn one-off experiments into scheduled, observable operating processes.    | Attach scoped tools, secrets, schedules, memory, and sub-agents.                           |
| Keep approval and action authority explicit for consequential outcomes.     | Run optional coding tasks in isolated Codex or Claude Code workers that produce draft PRs. |

The result is not another autonomous black box. It is a way to make agent work
repeatable, bounded, inspectable, and reviewable.

## Why Wardby instead of another agent runner?

Agent tools solve different layers of the problem. Wardby does not need to
replace them: it provides the self-hosted operating boundary around agents and
the work they perform.

| Category                   | What it primarily helps you do                              | What Wardby adds                                                                           |
| -------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Agent frameworks**       | Build reasoning loops, tool calls, and multi-agent logic.   | Persistent ownership, schedules, budgets, credentials, run history, and lifecycle control. |
| **Coding agents**          | Plan, edit, and test code for an interactive task.          | Isolated managed workers, admission-time budgets, scoped access, and optional draft PRs.   |
| **Hosted agent platforms** | Start quickly on infrastructure operated by another vendor. | A control plane, data, credentials, and execution boundary you can host in your own cloud. |
| **Workflow orchestrators** | Make application jobs durable, retryable, and observable.   | Agent-specific policy, model usage, capabilities, budgets, and MCP-native operations.      |

The distinction is control, not just execution. Wardby reserves spend before a
run starts, grants only assigned capabilities, records what happened, and
keeps downstream action authority separate from the worker that produced the
result.

## One control plane, the full lifecycle

![Wardby workflow: ask in Claude or Codex, define an agent through MCP, govern it in Wardby, execute it in isolation, and apply review policy to its outcome](https://raw.githubusercontent.com/wardby/wardby/main/docs/assets/wardby-workflow.svg)

Claude and Codex are the operator experience. Wardby is the durable system
behind them: it stores agent definitions, triggers work, reserves budget,
mediates tools and credentials, records outcomes, and exposes run state through
MCP.

## A full-cycle agent from one conversation

Ask your MCP client:

> Create a weekly dependency-maintenance agent for this repository. Use Claude
> Code, put it in a $5 weekly budget group, run it Thursday at 2:00 AM, execute
> the test suite, and open a draft pull request when a safe update is ready.
> Never merge automatically.

Claude or Codex can translate that request into Wardby MCP operations such as
`create_budget_group`, `create_agent`, `attach_tool`, `trigger_agent`, and
`get_run`. After that:

1. The scheduler or an event creates an owned run.
2. Wardby reserves budget and resolves only the capabilities assigned to that
   agent.
3. An isolated coding worker receives the task without receiving the GitHub App
   credential or provider API key.
4. The worker changes the checkout and runs its approved checks.
5. Trusted finalization validates the diff, pushes a unique branch, and opens at
   most one draft pull request.
6. A person reviews and decides whether anything merges.

The same agent can be updated, paused, triggered, inspected, or deleted from an
MCP conversation. The CLI remains available as the bootstrap and operations
floor.

## Agent ecosystems you can compose

Wardby provides lifecycle primitives rather than prescribing one fixed catalog.
These are example systems a team can build and manage through MCP:

| Agent system             | Typical cycle                                                      | Governed outcome                     |
| ------------------------ | ------------------------------------------------------------------ | ------------------------------------ |
| **Delivery pipeline**    | Work request → plan → implementation → tests → review              | Optional draft feature or bug-fix PR |
| **Security maintenance** | Scheduled scan → assess → patch → verify                           | Report or optional remediation PR    |
| **Architecture review**  | Inspect codebase → score risks → prioritize findings               | Architecture and risk report         |
| **QA coverage**          | Map journeys → rank gaps → add tests → run suite                   | Coverage report or optional test PR  |
| **System monitoring**    | Receive signal → investigate → correlate → escalate                | Actionable defect or incident report |
| **Project tracking**     | Read delivery data → compare plan, cost, and progress → flag drift | Portfolio or program update          |

Agents can stand alone or be connected as bounded sub-agents. Shared budget
groups can cap the combined spend of an ecosystem, while each agent retains its
own model, tools, schedule, and run history.

## Host it in your cloud

The core does not import a cloud SDK. Jobs, model access, email, secrets,
authentication, and object storage sit behind provider interfaces so operators
can choose the infrastructure boundary that fits their environment.

| Target                               | Current support                                                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| **Local Docker, VM, or on-premises** | Portable PostgreSQL and container workflow for development and self-hosting.                                     |
| **Production container baseline**    | Separate runtime and migration images plus a Compose/Caddy reference boundary.                                   |
| **GKE Autopilot**                    | Supported GCP reference with private Cloud SQL, isolated Codex worker pods, HTTPS Gateway, and immutable images. |
| **AWS**                              | The portable runtime and Bedrock model adapter are available; a native AWS deployment module is planned.         |
| **Other clouds**                     | Run the production image and provide equivalent PostgreSQL, secrets, ingress, egress, and monitoring controls.   |

Start with [deployment targets](https://github.com/wardby/wardby/blob/main/deploy/README.md), the
[portable production boundary](https://github.com/wardby/wardby/blob/main/deploy/production/README.md), or the
[GKE getting-started guide](https://github.com/wardby/wardby/blob/main/docs/getting-started-gke.md). Reference deployments are examples,
not a requirement to use one vendor.

**A complete deployment runs more than `wardby mcp`.** `mcp` serves the MCP
surface; the scheduler that fires due agents and the reconciler that recovers
orphaned runs live in `wardby scheduler`. Run **`wardby serve`** to get all three
in one process. It is the container image's default command and what a
single-container deployment (Cloud Run, a lone VM) should run. Alternatively,
run `mcp` and `scheduler` as two processes, as `deploy/production/compose.yml`
does. Running `mcp` alone logs a startup warning if enabled schedules exist
that nothing will fire.

## Bring your own observability

The coding proxy can expose standard Prometheus metrics at `/metrics` when
`METRICS_BIND` is configured. Collection is pull-based: keep the endpoint on a
private network and give only your chosen collector access to it.

| Destination                      | Integration path                                                                                                                                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Local Prometheus and Grafana** | The included Compose profile provisions Prometheus, Grafana, and dashboards for requests, errors, latency, cost, budgets, runs, and actual spend.                                                                                                  |
| **AWS CloudWatch**               | Configure the [CloudWatch Agent's Prometheus collector](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Agent-PrometheusEC2.html) to scrape Wardby over private EC2, ECS, or EKS networking and import selected metrics. |
| **Google Cloud Monitoring**      | Configure the [Google Cloud Ops Agent Prometheus receiver](https://cloud.google.com/stackdriver/docs/managed-prometheus/setup-opsagent), or a Managed Service for Prometheus collector, to scrape the private endpoint.                            |
| **Other monitoring platforms**   | Use any collector or hosted service that accepts the Prometheus exposition format.                                                                                                                                                                 |

Run the local proof without making a paid model request:

```sh
npm run observability:up
npm run observability:smoke
npm run observability:down
```

The included cloud deployments do not yet provision AWS or GCP collectors.
Current metrics primarily cover the coding proxy; application/MCP metrics,
production alerts, and SLOs remain operator responsibilities. See the
[observability guide](https://github.com/wardby/wardby/blob/main/docs/observability.md) for boundaries and retention.

## Security boundaries

- **Hard budget enforcement:** per-agent limits and shared daily, weekly, or
  monthly budget groups stop additional model work when the cap is reached.
- **Scoped capabilities:** tools, secrets, datastores, and sub-agents are
  attached explicitly and checked against the authenticated owner.
- **Sandboxed tools:** native agent tools execute inside a constrained QuickJS
  environment with controlled fetch and secret bindings.
- **Isolated coding workers:** Codex and Claude Code run in hardened containers
  with resource limits, protected paths, bounded output, and reviewed network
  access.
- **Credential separation:** workers do not receive provider credentials or the
  GitHub App private key; trusted components proxy model use and finalize Git.
- **Explicit action authority:** the worker that produces an outcome does not
  implicitly gain authority to apply it. Current coding finalization creates a
  draft pull request and does not auto-merge it.
- **Protected remote MCP:** HTTP transport is an OAuth 2.1 resource server;
  local stdio mode trusts the local operator.
- **Sanitized operations:** lifecycle events and metrics exclude prompts,
  repository content, credentials, diffs, and raw worker output.

Read the [runtime architecture](https://github.com/wardby/wardby/blob/main/docs/architecture-runtime.md),
[coding-worker isolation model](https://github.com/wardby/wardby/blob/main/docs/coding-worker-isolation.md), and
[security deployment guide](https://github.com/wardby/wardby/blob/main/docs/security-deployment.md) before enabling a
production repository.

Review policy is designed to support designated agents as well as people.
Agent approvals will be recorded as workflow evidence; operators will decide
whether that evidence permits an automated action or still requires a person.

## Quickstart

Requirements: Node.js 24 or newer, Docker, and one supported model-provider
credential.

```sh
npx --yes @wardby/cli@latest quickstart
```

The guided command checks prerequisites, creates private project-local
configuration, starts PostgreSQL in Docker, applies migrations, and offers to
run a small agent with a `$1` maximum budget. It can also register Wardby as a
local MCP server in Codex, Claude Code, or both.

Read the [Getting started guide](https://github.com/wardby/wardby/blob/main/docs/getting-started.md) for unattended setup,
MCP usage, lifecycle commands, and the boundary between the native demo and
isolated coding agents. For a shared cloud installation, follow the full
[GKE getting-started guide](https://github.com/wardby/wardby/blob/main/docs/getting-started-gke.md).

### Installing from npm

```sh
npm install @wardby/cli
```

`npm audit` will report a high-severity advisory in `deepmerge-ts`
([GHSA-ggr8-5vv4-36mx](https://github.com/advisories/GHSA-ggr8-5vv4-36mx)). It
is reached only through Prisma's CLI while it loads your own Prisma
configuration, and Prisma has not patched it in the 6.x line. This repository
clears it with an override, but npm does not apply a package's overrides to the
projects that install it — so add the same entry to your own `package.json`:

```json
"overrides": { "deepmerge-ts": "8.0.2" }
```

That override is tested against Prisma 6 and the CLI; the reasoning and the
retirement plan are in [SR-009](https://github.com/wardby/wardby/blob/main/docs/security-deployment.md#images-and-dependency-exception).

## What is implemented

- MCP-first agent, tool, schedule, budget-group, secret, datastore, webhook,
  run, and sub-agent management.
- Scheduled and event-triggered native agents with OpenAI, direct Anthropic,
  and Bedrock-Claude model routing.
- Per-run budgets, shared budget groups, usage accounting, and cancellation.
- QuickJS tool isolation with host allowlists and secret bindings.
- Containerized Codex and Claude Code executors with trusted GitHub draft-PR
  finalization.
- In-process reconciliation and optional DBOS durable workflows.
- Self-hosted or delegated OAuth for remote MCP access.
- Prometheus metrics and provisioned Grafana dashboards for local operations.
- Portable production images, a Compose/Caddy boundary, and a GKE Autopilot
  Terraform reference deployment.

This project is under active development. Run the
[release verification](https://github.com/wardby/wardby/blob/main/docs/release-verification.md) checks and review the
[security deployment guide](https://github.com/wardby/wardby/blob/main/docs/security-deployment.md) before production use.

## Repository map

```text
src/core/       Agents, runner, scheduler, triggers, budgets, and sandbox
src/mcp/        MCP transports, authentication, and management tools
src/providers/  Swappable model, job, VCS, email, auth, secret, and storage seams
src/coding-worker/ and src/claude-coding-worker/
                Isolated Codex and Claude Code execution
deploy/         Local, production-reference, observability, and cloud deployment
prisma/         Schema and reviewed migrations
docs/           Architecture, security, setup, and operator guidance
```

## License

Apache License 2.0. See [LICENSE](https://github.com/wardby/wardby/blob/main/LICENSE) for the license terms and
[NOTICE](https://github.com/wardby/wardby/blob/main/NOTICE) for attribution.

See [CONTRIBUTING.md](https://github.com/wardby/wardby/blob/main/CONTRIBUTING.md) to contribute and [SECURITY.md](https://github.com/wardby/wardby/blob/main/SECURITY.md)
to report a vulnerability privately.

Built as an independent reimplementation. See [CLEANROOM.md](https://github.com/wardby/wardby/blob/main/CLEANROOM.md).
