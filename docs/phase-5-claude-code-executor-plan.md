# Phase 5 Follow-up: Claude Code Executor Plan

Date: 2026-09-12

## Objective

Add Claude Code as a second isolated coding-worker implementation without
weakening the Phase 5 security contract. A coding profile chooses either
Codex or Claude Code; the trusted control plane continues to own credentials,
budget enforcement, GitHub checkout and draft-PR creation.

This is not a direct-API-key integration. The worker must never receive an
Anthropic, AWS, or GitHub credential, and it must have no Internet route other
than its per-run bridge to the trusted proxy.

## Scope And Decisions

### In scope

- Claude Code in non-interactive print/SDK mode inside the existing Docker
  isolation boundary.
- A per-run, capability-authenticated Anthropic Messages-compatible proxy
  route with reservation, authoritative usage metering, deadline cancellation,
  and a strict model allow-list.
- A provider-selected immutable worker image, trusted structured result
  parsing, existing GitHub finalization, recovery, and metadata-only audit
  events.
- Direct Anthropic API credentials for the first release. Bedrock and Vertex
  are explicitly deferred because their cloud credential chains require a
  separate identity-boundary review.

### Not in scope

- Letting a worker use `ANTHROPIC_API_KEY`, an OAuth login, host credentials,
  Docker access, direct network access, or Git metadata.
- A generic third-party gateway such as LiteLLM in the trusted path. Reevo's
  proxy remains the policy enforcement point and owns the usage ledger.
- Conversation resumption across jobs, automatic PR updates, auto-merge,
  GitLab/Bitbucket, or workflow-file edits.

### Architecture

Keep `ContainerExecutor` as the lifecycle and GitHub finalization owner. Codex
continues to use its current single worker. Claude Code uses one composite job
with two isolated containers and a private Unix-socket tool channel:

1. The **agent container** runs the pinned Claude Agent SDK, connects only to
   the trusted model proxy, and holds the short-lived run capability. It does
   not mount the repository and has no built-in file, shell, web, or MCP tools.
2. The **tool container** mounts the Gitless workspace and implements Reevo's
   bounded read, search, edit, and command tools. It has `--network none`, a
   separate PID namespace, no credential, and no model-proxy attachment.
3. A trusted, credential-free stdio relay in the agent container carries MCP
   messages over the shared Unix socket. Repository content can reach the
   model through tool results, but repository-controlled commands cannot read
   the agent process environment or call the model proxy.

The trusted executor selects both immutable image digests during dispatch and
persists the composite job selection. It must attest and clean both containers,
the socket, and their shared volume as one job.

The proxy gains protocol-specific ingress while retaining one session,
reservation, ledger, and cancellation model:

1. Codex uses the existing OpenAI Responses route.
2. Claude Code uses a new Anthropic Messages route only.
3. Both routes require the one-run capability, accept only the profile's
   allowed model, reserve budget before forwarding, meter only authoritative
   terminal provider usage, and cancel outstanding upstream work at deadline
   or run cancellation.

Do not infer a request's protocol from its model name. Store an explicit
provider/protocol selection in the coding-run snapshot and session so a future
model alias cannot cross a billing or authentication boundary.

## Delivery Plan

### Current implementation status (2026-09-12)

- Tasks 0-5 are complete. The pinned SDK contract, explicit provider routing,
  Anthropic Messages proxy, credential-separated worker/tool images, composite
  Docker lifecycle, deterministic acceptance suite, and capped live smoke all
  pass without giving either worker a long-lived provider or GitHub credential.
- Task 6 is implemented by the release-closure change: `verify:claude-code`,
  Claude compatibility and Docker acceptance in CI, SBOMs and Trivy scans for
  both runtime images, updated operator documentation, and final security
  evidence. Phase 5 is release-closed when that change is green on GitHub.
- The live run `cmtyjdclo0001sqreyrmd4jjt` used `claude-sonnet-5`, spent
  `$0.008709` of a `$0.25` cap, and opened draft PR #16 containing exactly one
  requested file. The PR was verified, closed without merge, and its branch
  deleted. The proxy fix was merged separately in PR #17.

### Task 0: Compatibility and threat-model spike

Pin one Claude Code release in a disposable proof image. Verify its documented
non-interactive API with a fake, in-process Anthropic Messages endpoint:

- Confirm the exact environment variables, authentication header(s), base URL
  behavior, model selection, permission controls, structured/stream output,
  cancellation behavior, and terminal usage event shape.
- Prove it runs without a home-directory login, auto-updater, telemetry egress,
  MCP configuration, or any credentials in its child shell environment.
- Record the observed wire contract as fixtures, not raw live traffic, and
  decide whether the TypeScript SDK or the pinned CLI is the smaller,
  more testable surface.
- Update this plan with the pinned package version and the supported Claude
  model IDs before implementation begins.

**Exit criteria:** a hermetic test demonstrates one successful fake completion,
one budget rejection, cancellation, and a malformed response failure. If
Claude Code requires unproxyable services beyond the approved Messages
endpoint, stop and redesign rather than adding egress exceptions.

#### Task 0 findings (2026-09-12)

- Pinned `@anthropic-ai/claude-agent-sdk` `0.3.269`, which bundles Claude Code
  `2.1.269`; its Zod 4 and SDK peers are isolated from Reevo's main runtime.
- Startup sends unauthenticated `HEAD /api/hello`, then model traffic to
  `POST /v1/messages?beta=true` with the run token in `x-api-key`.
- The default request ceiling is 64,000 output tokens and retries default to
  ten. The worker must force `CLAUDE_CODE_MAX_OUTPUT_TOKENS=4096` and
  `CLAUDE_CODE_MAX_RETRIES=0` so deadlines and budget reservations are useful.
- API failures are thrown by the SDK iterator. A malformed stream receives one
  automatic non-streaming fallback even with retries disabled. Cancellation
  takes approximately two seconds because the SDK gives the child process a
  graceful shutdown window.
- Claude adds device/session metadata and dynamic system reminders. The trusted
  proxy must remove client metadata before forwarding and bound accepted beta
  headers and request fields.
- A provider credential in `ANTHROPIC_API_KEY` is inherited by built-in Bash
  unless Claude's nested command sandbox is enabled. Managed credential
  scrubbing works on macOS. In the production-style Linux container,
  bubblewrap cannot create its user namespace under Docker's built-in seccomp
  profile; it fails closed when configured correctly. Disabling seccomp makes
  the namespace work but is not an acceptable production tradeoff.
- Decision: retain Docker's existing seccomp/capability policy and use the
  credential-separated two-container design above. Do not use Claude's
  built-in workspace or Bash tools in production.

### Task 1: Provider and profile contract

Extend the coding profile and persisted run snapshot with an explicit worker
provider, initially `codex | claude-code`. Validate model membership against
that provider's pricing roster at create and dispatch time. Preserve existing
Codex profile JSON and database rows through defaults/migration.

Add a provider-to-image resolver. It must require an immutable digest, resolve
once during dispatch, persist it, and fail closed for an unconfigured
provider/toolchain/version combination. Do not allow `workerImageRef` to
silently select a different provider image.

**Tests:** profile schema, import/preflight, dispatch snapshot, routing, Prisma
migration defaults, and backward compatibility for existing Codex agents.

### Task 2: Protocol-aware proxy sessions

Add `protocol` to the trusted proxy session contract and database ledger.
Refactor shared capability authentication, model allow-list, deadline,
reservation, idempotency, cancellation, and safe audit events out of the
OpenAI request parser.

Implement the Anthropic Messages ingress as a distinct strict parser:

- Accept only `POST /v1/messages` with bounded JSON and the selected model.
- Support only the Claude Code request fields proven by Task 0; reject tools,
  server-side MCP, batch/background, prompt caching changes, or unknown
  features until separately reviewed.
- Forward only to the fixed `https://api.anthropic.com` host with the trusted
  credential resolved on the proxy host. Never reflect the credential,
  provider body, prompt, tool output, or raw error upstream.
- Parse authoritative terminal usage from JSON or SSE before committing cost.
  If the request outcome or usage is ambiguous, retain the reservation and
  classify it as uncertain rather than undercharging.
- Give each protocol independent golden request/response fixtures and a
  protocol-confusion test matrix.

**Tests:** authentication, body and header bounds, provider allow-list,
idempotency, cancellation, deadline, successful JSON/SSE metering, no-usage
failure, budget exhaustion, DNS pinning, and safe error/log assertions.

### Task 3: Claude worker image and driver

Create `src/claude-coding-worker/` and `src/claude-tool-runner/` with pinned
base images and dependencies plus SBOM/image-policy checks. Disable updates
and nonessential traffic and ensure no host user or preexisting Claude settings
are copied into either image.

Implement a Claude driver with the same trusted input/output contract as the
Codex driver:

- The agent reads only `/run/reevo/input/input.json`, writes only the atomic
  bounded result artifact, and accesses the repository only through the
  credential-free tool runner.
- Supply the fixed security instructions and task, use non-interactive mode,
  a fixed working directory, a fixed maximum turn count, no approval prompts,
  no MCP servers, and no resume/continue state.
- Configure only the private proxy bridge and a one-run capability. Disable all
  built-in tools and register only the stdio-to-Unix-socket relay. The tool
  container must never receive the agent environment or join the proxy network.
- Convert Claude's final response to the existing `CodingAgentOutput` schema;
  validate run ID, redact token-shaped values, and emit only safe progress
  categories. Unknown or malformed output fails closed.

**Tests:** driver unit tests mirroring the Codex worker tests, process
invocation/configuration capture, tool relay and path confinement, capability
non-leakage across PID/network namespaces, malformed output, provider failure,
budget result, signal cancellation, and both image policies.

### Task 4: Container composition and recovery

Pass the explicit provider through executor preflight, proxy session, composite
job selection, and labels. Extend the Docker job contract to attest, stop,
collect, recover, and remove the Claude agent and tool containers as one
persisted handle. Preserve protected-path validation and trusted GitHub
finalization unchanged.

Update observability only with safe metadata: worker provider and protocol may
be recorded as enumerated values; task, model request bodies, source files,
diffs, environment values, capabilities, raw provider output, and credentials
remain forbidden.

**Tests:** successful Claude-code lifecycle, cancellation, deadline/budget
cutoff, worker crash, recovery never relaunches, cleanup deletes all artifacts,
and Codex regressions continue to pass unchanged.

### Task 5: Docker and adversarial acceptance

Build the Claude image locally and run the existing Docker isolation suite
against it. Add probes that confirm:

- no default route except the per-run proxy bridge;
- no Docker socket, host mounts, Git metadata, or writable root filesystem;
- no outbound access to Anthropic, telemetry, update, or arbitrary hosts;
- only the trusted proxy can use the Anthropic credential;
- the agent container cannot mount the workspace and the tool container cannot
  reach the agent's PID namespace or proxy network;
- denied direct and malformed proxy requests cannot spend a budget;
- protected paths and an attempted `.git` write cannot reach trusted
  finalization.

Run a deterministic fake-provider acceptance test followed by a tiny live
smoke in a dedicated fixture repository and GitHub App installation. The live
smoke must create one harmless file, verify the exact draft PR, record cost and
run ID, then close the PR and delete its branch.

### Task 6: Documentation and release gate

Update the Phase 5 release gate, local smoke guide, isolation guide,
configuration reference, and example `.env` comments. Document credential
setup as `CODING_ANTHROPIC_CREDENTIAL_REF` resolved only by the proxy host;
never instruct operators to put an API key in the worker image or worker
environment.

Add `verify:claude-code` and make Phase 5 verification cover both worker
providers. CI must build both pinned images, generate and scan both SBOMs, run
proxy and isolation acceptance tests, and retain only safe test artifacts.

**Status:** Complete locally on 2026-09-12. Release closure requires the
GitHub checks for the closure change to pass.

## Release Criteria

The feature is ready only when all of the following are true:

- Codex behavior and its release gate remain green.
- The Claude image and package version are pinned and verified by image policy.
- The proxy holds the only long-lived Anthropic credential; workers have only
  a short-lived, per-run capability.
- Budget reservation, authoritative reconciliation, deadline cancellation,
  and ambiguous-usage handling work for Messages JSON and streaming responses.
- Every failure and recovery path cleans worker, keeper, network, volume,
  artifact, and trusted workspace state.
- A live fixture run produces one draft PR within a deliberately small budget
  and is fully cleaned up afterward.
- An independent security review confirms no new direct egress, credential
  exposure, provider-protocol confusion, or unsafe telemetry.

## Suggested Implementation Shape

Use one worktree and split commits by the task boundaries above. Do not begin
Task 2 before Task 0 produces a checked-in compatibility fixture; the external
Claude Code interface is the primary integration risk. Run a `gpt-5.6-sol`
high-reasoning review after Tasks 2 and 5, because those changes control
credentials, billing, and network isolation.

## References

Anthropic documents Claude Code's non-interactive mode, JSON/streaming output,
model and permission flags in its [CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage).
Its [LLM gateway guidance](https://docs.anthropic.com/en/docs/claude-code/llm-gateway)
also confirms that Claude Code can target a controlled base URL with a
dedicated authentication token. These interfaces must be revalidated against
the exact pinned release in Task 0 rather than assumed stable.
