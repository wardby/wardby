# Agent recipes

Two complete agent setups you can ask your MCP client to build, made only from
shipped Wardby features:

- [Recipe A: an architecture keeper](#recipe-a-an-architecture-keeper), three
  cooperating agents that keep a repository's architecture knowledge accurate.
- [Recipe B: a builder per language](#recipe-b-a-builder-per-language), a
  coding agent that turns an `@mention` into a draft pull request, with notes for
  Node/TypeScript, Python, and other languages.

Each recipe gives the one-paragraph ask you paste into Claude or Codex, the
configuration that results, and what it produces. Both use `your-org/your-repo`
as a placeholder repository.

Agent names are unique across the whole instance, so the examples use
repo-scoped names such as `<repo>-architect`. The sub-agent bound names
(`architect`, `builder`) stay fixed so the delegate tools keep their names.

## Before you start

These recipes go beyond the quickstart. Check each item.

1. **Version.** The recipes require Wardby 0.4.0 or later. The knowledge note in
   coding runs, `wardby knowledge check`, and the `push` trigger are not in
   earlier releases.
2. **Coding-agent setup.** The quickstart runs native agents only: it does not
   install a GitHub App or build worker images. Both recipes use coding agents,
   so complete [Coding-agent setup](coding-agent-setup.md) first: a GitHub App
   installed on the repository, a worker image, the coding proxy, and a Docker or
   Kubernetes job launcher. Run `wardby coding preflight` to check it. For a
   hosted deployment, [Getting started on GKE](getting-started-gke.md) covers
   this.
3. **A GitHub account link.** Link your GitHub account once with
   `link_host_account`. Creating a coding agent or linking a repository checks
   that you have write access to the repository
   ([details](code-review-agents.md#who-may-give-an-agent-a-repository)).
4. **A public HTTPS URL for GitHub webhooks.** The event triggers (`push` for the
   merge watcher, `pull_request` for the reviewer, `mention` for the router) work
   only when GitHub can deliver webhooks to your Wardby instance. Set the App's
   webhook URL to `https://<your-host>/hosts/github/events` and its webhook
   secret to the value of `GITHUB_APP_WEBHOOK_SECRET`
   ([registering the App](code-review-agents.md#registering-the-github-app)). A
   laptop install is not reachable from GitHub by default, so it needs a public
   HTTPS endpoint in front of it (the
   [runtime architecture](architecture-runtime.md) diagram shows an HTTPS tunnel
   in front of the local server) or a hosted deployment such as
   [GKE](getting-started-gke.md). Scheduled and manually triggered runs need no
   webhook.
5. **App events.** Tick the events each trigger needs in the App's settings:
   Pull request and Check run for reviews; Issue comment, Pull request review
   comment, and Issues for mentions; and **Push** for the merge watcher. Each is
   its own checkbox
   ([registering the App](code-review-agents.md#registering-the-github-app)).
6. **Models.** Pick ids from `list_models` ([Models and pricing](models.md)). The
   examples use `claude-sonnet-5` for the capable coding model and
   `claude-haiku-4-5` for the small fast one; use whatever your deployment has
   enabled. A coding agent's model must be supported by its coding provider.

## Recipe A: an architecture keeper

**What it does.** Keeps `docs/knowledge/` (see
[Architecture knowledge bundles](knowledge.md)) accurate and growing, and lets
coding agents and reviewers use it. **Triggers:** the architect runs weekly on a
schedule; the merge watcher runs on every merge to the default branch; the
reviewer step runs on every pull request.

### The MCP ask

> Set up an architecture keeper for `your-org/your-repo`. Create a Claude Code
> coding agent called `<repo>-architect` with the reference architecture-agent prompt
> from the Wardby knowledge guide and a $3 per-run budget. Trigger it once and
> show me the run; don't schedule it yet. After I've reviewed its first pull
> request, schedule it for Mondays at 6:00 AM. Then create a small, cheap native
> agent called `<repo>-merge-watcher` with the reference watcher prompt, attach
> `architect` to it as a sub-agent named `architect`, and link it to the
> repository with the `push` trigger. Finally, add the reviewer step to my
> existing code-review agent's prompt.

### The resulting configuration

Do the steps in this order; each depends on the one before.

1. **Create the architect.**
2. **Trigger it once by hand** (`trigger_agent`) and review the draft pull
   request it opens.
3. **Schedule it** (`set_schedule`).
4. **Create the watcher**, attach the architect, tick **Push** in the App's
   events, and link it with `push`.
5. **Add the reviewer step** to your review agent's prompt.

<details>
<summary>Architect (coding agent)</summary>

| Setting           | Value                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `name`            | `<repo>-architect`                                                                                       |
| `kind`            | `coding`                                                                                                 |
| `model`           | a capable coding model, for example `claude-sonnet-5` with `provider: "claude-code"`                     |
| `budgetUsd`       | `3` per run (docs-only work)                                                                             |
| `codingProfile`   | `provider`, `repository: "your-org/your-repo"`, `baseRef` (your default branch), and `defaultTask` below |
| `schedule`        | `0 6 * * 1` with your `timezone`, set after the first manual run (`set_schedule`)                        |
| Tools, sub-agents | None                                                                                                     |
| Repository checks | May be skipped; the work is docs-only                                                                    |
| System prompt     | The architect prompt in [Architecture knowledge bundles](knowledge.md#set-up-an-architecture-agent)      |

`defaultTask`, required before a coding agent can be scheduled:

```text
Weekly knowledge review. Run the full cycle described in your instructions for
this repository. Your file changes are collected into a pull request for review;
don't try to commit or open one yourself.
```

The prompt is published once, in the knowledge guide, so this page cannot drift
from it. Copy it from there, unchanged, as the agent's `systemPrompt`.

</details>

<details>
<summary>Merge watcher (native agent)</summary>

| Setting       | Value                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `name`        | `<repo>-merge-watcher`                                                                                                         |
| `kind`        | `native`                                                                                                                       |
| `model`       | a small fast model, for example `claude-haiku-4-5`                                                                             |
| `budgetUsd`   | Sized for the architect's per-run cost: the run tree shares one budget, so at least `3` plus a little for the watcher itself   |
| Sub-agent     | `attach_subagent` with `parentAgentId` the watcher, `childAgentId` the architect, `boundName: "architect"`                     |
| Link          | `link_repository` with `access: "write"`, `triggers: ["push"]`, no `checkName`                                                 |
| System prompt | The reference watcher prompt in [Drift runs on merge](knowledge.md#set-up-the-merge-watcher), copied unchanged from that guide |

The bound name gives the watcher a `delegate_to_architect` tool, which the
reference prompt calls.

```json
{
  "agentId": "<watcher agent id>",
  "repository": "your-org/your-repo",
  "access": "write",
  "triggers": ["push"]
}
```

Only pushes to the default branch start it. If the watcher already has a run
pending or running, the next merge starts nothing; the weekly run catches up.

</details>

<details>
<summary>Reviewer knowledge step</summary>

Append the "Reviewer step" section from
[Architecture knowledge bundles](knowledge.md#reviewer-step) to the system
prompt of a code-review agent ([Code-review agents](code-review-agents.md)). No
other setting changes. It makes reviews read the bundle's index, apply the
concepts that match the changed files, and report stale citations on knowledge
pull requests as suggestions only.

</details>

### What it produces

- A weekly draft pull request that touches only `docs/knowledge/` and an
  `AGENTS.md` pointer, adding cited concepts and re-anchoring stale ones. A
  person reviews and merges it.
- After each merge that touches a concept's files, a drift run limited to the
  affected concepts, as another draft pull request.
- Reviews that cite the relevant concepts.
- Every later coding run for the repository (Recipe B) receives the knowledge
  index and base commit automatically.

Run `wardby knowledge check` locally or in CI to validate the bundle. The
format, the check's codes, and drift behavior are in
[Architecture knowledge bundles](knowledge.md).

## Recipe B: a builder per language

**What it does.** Turns an `@mention` on an issue or pull request into a draft
pull request. A native router agent reads the request and delegates to a coding
builder agent. **Trigger:** the router is linked with `mention`; only people with
write access to the repository can start it.

### The MCP ask

> For `your-org/your-repo`, create a Codex coding agent called `<repo>-builder` with a
> $5 per-run budget and a 30 minute timeout, starting from the default branch.
> Allow it to install these packages from the registry: (your dependencies).
> Then create a small native agent called `<repo>-router` with a $6 budget, attach
> `builder` to it as a sub-agent named `builder`, and link it to the repository
> with the `mention` trigger. The router should ask for details when a request is
> unclear and otherwise delegate one precise task to the builder. Never merge
> anything.

Pick the language section below for the toolchain and package settings.

### Common configuration

<details>
<summary>Router (native agent)</summary>

| Setting     | Value                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------ |
| `name`      | `<repo>-router`                                                                                        |
| `kind`      | `native`                                                                                               |
| `model`     | a small fast model, for example `claude-haiku-4-5`                                                     |
| `budgetUsd` | The builder's budget plus a little: the run tree shares one budget                                     |
| Sub-agent   | `attach_subagent` with `parentAgentId` the router, `childAgentId` the builder, `boundName: "builder"`  |
| Link        | `link_repository` with `access: "write"`, `triggers: ["mention"]` (one `mention` agent per repository) |

```json
{
  "agentId": "<router agent id>",
  "repository": "your-org/your-repo",
  "access": "write",
  "triggers": ["mention"]
}
```

System prompt:

The prompt is published once, in the [builder-agent help article](../help/builder-agent.md#router-prompt). Copy it unchanged as the agent's `systemPrompt`.

The router's final reply is posted where the mention was, so never instruct it
to include secrets or internal details. See
[What the mention agent receives](code-review-agents.md#what-the-mention-agent-receives).

</details>

<details>
<summary>Builder (coding agent) fields that matter</summary>

| Field (`codingProfile`) | What to set                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `model` (agent field)   | A capable coding model the chosen provider supports, for example `gpt-5.6-terra` with `codex` or `claude-sonnet-5` with `claude-code`; a mismatch is refused |
| `provider`              | `codex` or `claude-code`; the agent's `model` must be one that provider supports                                                                             |
| `repository`            | `your-org/your-repo`; your linked GitHub account needs write access                                                                                          |
| `baseRef`               | The branch runs start from, usually your default branch                                                                                                      |
| `toolchain`             | `node` or `node-python` (per language below)                                                                                                                 |
| `toolchainVersion`      | `"3.12"` for `node-python`; omit for `node`                                                                                                                  |
| `packageAllowlist`      | Top-level packages per ecosystem (`npm`, `pypi`). Needs `packages:approve` or `agents:admin`                                                                 |
| `packagePolicy`         | Optional `minReleaseAgeDays` (0 to 30)                                                                                                                       |
| `services`              | Catalog service names the agent may start, for example `["postgres"]`; see [Services](coding-services.md)                                                    |
| `protectedPaths`        | Globs a run may not change, for example `[".github/**", "CODEOWNERS"]`. `.wardby/**` is always protected except `.wardby/services.yaml`                      |
| `timeoutSec`            | 60 to 7200; for example `1800`                                                                                                                               |
| `workerImageRef`        | Digest-pinned custom image; needs `agents:admin` (see "Other languages")                                                                                     |
| `defaultTask`           | Needed only to schedule the agent                                                                                                                            |
| Agent `budgetUsd`       | Per-run budget, reserved at dispatch, for example `5`                                                                                                        |

The agent's `systemPrompt` is placed ahead of each request as standing
instructions. The template below is generic.

</details>

<details>
<summary>Builder system prompt template</summary>

The prompt is published once, in the [builder-agent help article](../help/builder-agent.md#builder-prompt), so this page cannot drift from it. Copy it unchanged as the agent's `systemPrompt`.

Adjust the numbered rules to your project; keep rules 1, 5, and 6.

</details>

Package error codes are in [Installing packages in coding runs](coding-packages.md).
Make sure the repository's `AGENTS.md` lists the test and lint commands, because
the builder takes them from there.

### Node / TypeScript

Use the stock worker image: `toolchain: "node"`, no `toolchainVersion`. The
agent runs `npm ci` or `npm install` through the registry proxy, so enable the
packages your project needs (top-level entries only; the dependency graph is
added automatically):

```json
{
  "provider": "codex",
  "repository": "your-org/your-repo",
  "baseRef": "main",
  "toolchain": "node",
  "timeoutSec": 1800,
  "packageAllowlist": {
    "npm": ["react@^19", "vitest", "@testing-library/*"]
  },
  "packagePolicy": { "minReleaseAgeDays": 3 },
  "protectedPaths": [".github/**", "CODEOWNERS"]
}
```

Test commands come from `AGENTS.md` (for example `npm test` and `npm run lint`).
Lockfile installs are verified against the registry before npm runs; see
[Installing packages in coding runs](coding-packages.md).

### Python

Use the `node-python` toolchain with version `3.12`, which adds Python 3 with
`pytest` and `ruff` next to Node. Pip installs go through the registry proxy
into a virtual environment, and only wheels are served (source distributions are
refused), so allow packages that publish wheels. Extras such as `[binary]` are not accepted in an allowlist entry; list the wheel package's own name instead (`psycopg-binary`, not `psycopg[binary]`):

```json
{
  "provider": "codex",
  "repository": "your-org/your-repo",
  "baseRef": "main",
  "toolchain": "node-python",
  "toolchainVersion": "3.12",
  "timeoutSec": 1800,
  "packageAllowlist": {
    "pypi": ["flask>=3", "sqlalchemy>=2", "psycopg-binary>=3"]
  },
  "services": ["postgres"]
}
```

`services` is optional. When the tests need a database, commit
`.wardby/services.yaml` to the base branch:

```yaml
services:
  postgres: "16"
```

Each run then gets a fresh, empty PostgreSQL instance and a `DATABASE_URL`
variable; say so in `AGENTS.md` so tests read it. See
[Services for coding runs](coding-services.md) for the catalog, variables, and
errors. For Claude Code on `node-python`, the operator also sets
`CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12` (see
[Coding-agent setup](coding-agent-setup.md)).

### Other languages (Go, Java, Rust, ...)

Wardby ships worker images only for `node` and `node-python`. For any other
toolchain, build your own image on Wardby's driver base image and point the
agent at it with `workerImageRef`, a digest-pinned reference (a mutable tag is
rejected). Setting it needs the `agents:admin` scope and the admin role. The
Dockerfile shape, the driver image, and what Wardby does and does not verify are
in [Bring-your-own worker images](coding-worker-byo-images.md).

```json
{
  "provider": "codex",
  "repository": "your-org/your-repo",
  "baseRef": "main",
  "toolchain": "node",
  "workerImageRef": "registry.example.com/your-org/worker-go@sha256:<64 hex>",
  "timeoutSec": 1800
}
```

`toolchain` is still required; the worker image's own toolchain is what runs.

What the package registry covers: only **npm and PyPI** are mediated. A Go,
Maven, Cargo, or other ecosystem has no registry proxy, and the worker has no
direct network access, so those dependencies must be baked into your image or
already vendored in the repository. The registry still applies to any npm or
pip use inside the same run, and `packageAllowlist` has no entry for other
ecosystems. If services are allowed, the image must be built on driver v11 or
later.

### Together with Recipe A

Coding runs automatically receive the repository's knowledge index and base
commit when `docs/knowledge/index.md` exists on the base branch
([how coding runs use the bundle](knowledge.md#how-coding-runs-use-the-bundle)),
so the builder works from recorded pitfalls and invariants. Recipe A keeps that
bundle current.

### What it produces

A mention from someone with write access gets a "Working on it" status comment
from the App. The router either asks a question or delegates, the builder
pushes a unique branch and opens at most one draft pull request, and the App
edits the status comment with the pull request link or the failure. A person
reviews and merges; Wardby never merges for you. A later mention on that pull
request continues the same branch.

## Next steps

- [Architecture knowledge bundles](knowledge.md)
- [Code-review agents](code-review-agents.md)
- [Coding-agent setup](coding-agent-setup.md)
- [Models and pricing](models.md)
