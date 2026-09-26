<div>
  <img align="left" hspace="24" src="https://raw.githubusercontent.com/wardby/wardby/main/docs/assets/brand/wardby-mascot.png" alt="Wardby guardian robot protecting an agent budget" width="280">
  <h3><big><big>Wardby</big></big> <small><em>(pronounced&nbsp;“WARD&#8209;bee”)</em></small></h3>
  <h3>Autonomous agents, bounded by design.</h3>
  <p><strong>Agent runners help a model complete a task. Wardby is the self-hosted control plane that governs the work around it: whether it may run, what it may access, what it may spend, and what reviewable outcome it may produce.</strong></p>
  <br clear="left">
  <p><strong>Budgets are enforced before spend: every model request must fit within a hard run limit before it reaches the provider.</strong></p>
  <p><strong>Bring your providers. Keep your infrastructure. Govern agents in one place.</strong></p>
  <p>
    <a href="#get-started">Get started</a> ·
    <a href="#why-wardby">Why Wardby</a> ·
    <a href="#where-wardby-fits">Where it fits</a> ·
    <a href="#a-full-cycle-agent-from-one-conversation">Full-cycle example</a> ·
    <a href="#host-it-in-your-cloud">Deployments</a> ·
    <a href="#bring-your-own-observability">Observability</a> ·
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

## Get started

### Run locally in five minutes

Requirements: Node.js 24 or newer, Docker, and an OpenAI or Anthropic API key.
You do not need to clone Wardby or install PostgreSQL.

1. From the project where you want to use Wardby, run:

   ```sh
   npx --yes @wardby/cli@latest quickstart
   ```

2. Follow the prompts to choose a provider, start PostgreSQL, create a `$1`
   demo agent, and optionally connect Codex or Claude Code through MCP.

3. Verify the installation:

   ```sh
   npx --yes @wardby/cli@latest doctor
   ```

Quickstart keeps credentials and local state under `.wardby/` in the current
project. Read the [local getting-started guide](https://github.com/wardby/wardby/blob/main/docs/getting-started.md)
for unattended setup, lifecycle commands, MCP configuration, and cleanup.

### Develop Wardby from source

Clone the repository only when you want to contribute to Wardby, inspect its
deployment assets, or build images yourself:

```sh
git clone https://github.com/wardby/wardby.git
cd wardby
npm ci
npm run build
npm test
```

Continue with [CONTRIBUTING.md](https://github.com/wardby/wardby/blob/main/CONTRIBUTING.md)
for the development database, migrations, required checks, and contribution
expectations.

### Deploy for a team

- Follow the [GKE guide](https://github.com/wardby/wardby/blob/main/docs/getting-started-gke.md)
  for the supported Google Cloud reference deployment.
- Start from the [portable production boundary](https://github.com/wardby/wardby/blob/main/deploy/production/README.md)
  for another cloud, VM, or container platform.
- Follow [Bring your own identity provider](https://github.com/wardby/wardby/blob/main/docs/getting-started-identity-provider.md)
  to protect remote MCP with your existing OAuth/OIDC provider.

## Why Wardby

AI agents are easy to demo and harder to operate. Once an agent can spend
money, use credentials, change a repository, or run without a person watching,
teams need more than a prompt and a cron job.

### One control plane instead of scattered automation

Teams often begin with Claude Code or Codex on developer machines,
repository-specific automation, and separate provider dashboards. As adoption
grows, agent definitions, ownership, credentials, budgets, schedules, and run
history become fragmented across tools and repositories.

Wardby gives every Wardby-managed agent one durable operational identity: who
owns it, why it exists, what it may access, when it runs, what it may spend,
and what outcome it produced.

Wardby provides the control plane around the model:

| For engineering leaders                                                      | For developers                                                                             |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Keep an inventory of owned agents, purposes, schedules, limits, and results. | Create and manage agents from Claude or Codex through MCP.                                 |
| See reserved budget and actual usage across Wardby-managed agents.           | Choose OpenAI, Anthropic, or Bedrock-backed models per agent.                              |
| Keep execution, data, and credentials in infrastructure your team controls.  | Switch approved models or builders without rewriting the governance contract.              |
| Turn one-off experiments into scheduled, observable operating processes.     | Attach scoped tools, secrets, schedules, memory, and sub-agents.                           |
| Keep approval and action authority explicit for consequential outcomes.      | Run optional coding tasks in isolated Codex or Claude Code workers that produce draft PRs. |

The result is not another autonomous black box. It is a way to make agent work
repeatable, bounded, inspectable, and reviewable.

## Where Wardby fits

Agent tools solve different layers of the problem. Wardby does not need to
replace them: it provides the self-hosted operating boundary around agents and
the work they perform.

| Category                    | What it primarily helps you do                              | What Wardby adds                                                                           |
| --------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Repository automation**   | Run jobs for one repository in response to delivery events. | One agent catalog, budget model, and policy boundary across repositories and triggers.     |
| **Agent frameworks**        | Build reasoning loops, tool calls, and multi-agent logic.   | Persistent ownership, schedules, budgets, credentials, run history, and lifecycle control. |
| **Coding agents**           | Plan, edit, and test code for an interactive task.          | Isolated managed workers, admission-time budgets, scoped access, and optional draft PRs.   |
| **Provider dashboards**     | Report usage and cost within one model provider.            | Agent-owned budgets, capabilities, runs, and outcomes across approved providers.           |
| **LLM gateways**            | Route model requests, manage keys, and enforce quotas.      | Budgets tied to named agents, owned runs, capabilities, schedules, and outcomes.           |
| **Observability platforms** | Trace requests, evaluate quality, and explain cost.         | Admission and execution controls applied before work occurs, plus a durable agent catalog. |
| **Vendor control planes**   | Govern agents inside one provider or cloud ecosystem.       | A self-hosted boundary spanning approved providers, builders, repositories, and clouds.    |
| **Workflow orchestrators**  | Make application jobs durable, retryable, and observable.   | Agent-specific policy, model usage, capabilities, budgets, and MCP-native operations.      |

The distinction is governed work, not just model calls or execution. Rather
than assembling a gateway, scheduler, agent catalog, budget service,
capability registry, and run database, Wardby provides one operating boundary.
It reserves spend before a run starts, grants only assigned capabilities,
records what happened, and keeps downstream action authority separate from the
worker that produced the result.

> **Scope:** Wardby's inventory and budget views cover work managed through
> Wardby. Provider reconciliation and unmanaged-agent discovery are required
> before those views can represent every AI agent or expense in an
> organization.

## One operational contract, the full lifecycle

![Wardby workflow: ask in Claude or Codex, define an agent through MCP, govern it in Wardby, execute it in isolation, and apply review policy to its outcome](https://raw.githubusercontent.com/wardby/wardby/main/docs/assets/wardby-workflow.svg)

Claude and Codex are the operator experience. Wardby is the durable operating
boundary between intent and agent execution: it stores agent definitions,
triggers work, reserves budget, mediates tools and credentials, records
outcomes, and exposes run state through MCP. Nothing runs until identity,
policy, and available budget agree.

### Governed shared state for agent teams

Named Wardby datastores let related agents exchange persistent structured data
without sharing an unrestricted database credential. Datastores are owned and
attached to agents explicitly; each sandboxed tool can reach only approved
bound names and key prefixes.

A planner can publish a feature plan, a builder can record implementation
state, and a reviewer or QA agent can add findings to the same governed
workspace. Datastores provide bounded coordination state, not a replacement
for authoritative source systems or searchable agent memory.

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
MCP conversation, and so can its sandboxed tools: `update_tool` fixes a tool's
code in place for the next run, and `delete_tool` removes one you no longer
need. The CLI remains available as the bootstrap and operations
floor. The result is autonomy with a receipt: an owned run with bounded spend,
assigned capabilities, durable status, and a reviewable outcome.

## Agent ecosystems you can compose

Wardby provides lifecycle primitives rather than prescribing one fixed catalog.
These are example systems a team can build and manage through MCP:

**Builders can vary. The controls do not.** Each system inherits the same
budget, capability, identity, evidence, and review contract.

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

**Bring your providers. Keep your infrastructure. Govern agents in one place.**

The core does not import a cloud SDK. Jobs, model access, email, secrets,
authentication, and object storage sit behind provider interfaces so operators
can choose the infrastructure boundary that fits their environment. Models,
coding executors, cloud platforms, and observability systems can change
independently instead of defining the agent architecture. This reduces
control-plane lock-in without pretending that source control, model providers,
or monitoring systems disappear.

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

For a single-container deployment, run **`wardby serve`** to start MCP, the
scheduler, and reconciliation together. Split deployments can run `wardby mcp`
and `wardby scheduler` separately; `mcp` alone does not fire schedules. See the
deployment guides above for the complete process boundary.

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
  Group caps apply to native and coding runs alike, whether scheduled,
  webhook-, MCP-, host-event- or sub-agent-triggered: a coding run reserves at
  most what its group has left and is refused (`budget_group_exhausted:<period>`)
  when nothing is left. A run still in flight holds its unspent reservation
  against the group, so concurrent runs cannot each claim the same remainder.
- **Scoped capabilities:** tools, secrets, datastores, and sub-agents are
  attached explicitly and checked against the authenticated owner. Agents are
  private until their owner shares them (`grant_access` at read, execute or
  write), and one owner's secrets, datastores, repositories and sub-agents
  never reach another owner's agent without a grant on that exact resource.
- **Sandboxed tools:** native agent tools execute inside a constrained QuickJS
  environment with controlled fetch and secret bindings.
- **Isolated coding workers:** Codex and Claude Code run in hardened containers
  with resource limits, protected paths, bounded output, and no network access
  except the coding proxy.
- **Allowlisted package installs:** a coding agent's `npm`/`pip` installs (Codex
  workers only) are limited to an approved dependency graph, served through the
  same proxy with a minimum release age, an OSV vulnerability audit, and every
  package recorded.
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

## Optional npm installation

The `npx` quickstart above requires no installation. To pin Wardby as a local
project dependency instead:

```sh
npm install @wardby/cli
```

That install is audit-clean: the published package carries no Prisma CLI,
`@prisma/config`, `deepmerge-ts`, or `mysql2`, so `npm audit` reports nothing
and no `overrides` entry is needed in your own `package.json`.

`wardby quickstart` and `wardby doctor` separately fetch the pinned Prisma CLI
(`prisma@7.10.0`) on demand via `npx` to run migrations, so the machine running
them needs npm registry access at that moment. See
[Images and dependencies](https://github.com/wardby/wardby/blob/main/docs/security-deployment.md#images-and-dependencies)
for the repository's own dependency-override policy.

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
