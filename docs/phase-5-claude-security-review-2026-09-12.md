# Phase 5 Claude Code Security Review

Date: 2026-09-12

## Decision

No production-blocking Claude Code security issue remains in the reviewed Phase
5 boundary. Release remains conditional on green GitHub checks for the exact
commit, immutable production image references, retained SBOMs, and successful
Trivy scans.

## Reviewed Boundary

- Explicit provider routing and immutable dispatch snapshots.
- Anthropic Messages ingress authentication, host and model enforcement,
  deadlines, idempotency, budget reservation, and fail-closed usage accounting.
- The pinned Claude Agent SDK, exact beta allowlist, request metadata, system
  prompt forms, reviewed tool loop, structured output, fallback behavior, and
  usage extraction.
- Credential-separated agent and tool-runner containers, a networkless tool
  runner, the fixed MCP command surface, and trusted GitHub finalization.
- Live evidence from run `cmtyjdclo0001sqreyrmd4jjt` and the closed, unmerged
  smoke-test PR #16.

## Findings Closed

1. The proxy previously dropped the Claude SDK's `anthropic-beta` header. It now
   forwards only the exact reviewed allowlist, binds that fingerprint to the
   session capability, and rejects malformed or unreviewed values before
   resolving the provider credential.
2. The proxy now accepts only the reviewed local command tool, corresponding
   tool-result messages, and the SDK's second-turn string-form system prompt.
   It does not rewrite these messages into a broader capability.
3. The Claude worker is split into an egress-capable agent container and a
   networkless tool runner connected by a private Unix socket. The proxy receives
   the upstream credential; neither worker receives it.
4. The proxy and tool runner now share the same 16 KiB command byte limit, so an
   oversized command is rejected before credential resolution and cannot cross
   a more permissive trusted boundary.

## Residual Risks And Controls

- Claude SDK or beta-version drift fails closed until its protocol shape is
  reviewed and the explicit allowlist is updated.
- Docker isolation shares the host kernel. Production hosts must remain
  dedicated and patched, with the documented seccomp, capability, filesystem,
  process, memory, and timeout controls intact.
- The tool runner remains the final authority for command validation. It is
  networkless, exposes one fixed MCP tool, applies resource limits and protected
  paths, and returns changes only through the trusted finalizer.
- A successful provider response without authoritative usage remains uncertain;
  its reservation is held rather than undercharging the budget.
- The live Claude smoke is intentionally manual and capped. CI uses deterministic
  protocol fixtures and local fake-provider acceptance tests, never a paid
  provider call.

## Required Release Evidence

1. `npm run verify:phase5` and `npm run verify:claude-code` pass.
2. `npm run test:phase5:database` passes against a migrated PostgreSQL database.
3. GitHub `Security checks` builds both Claude images, runs the composite-worker
   acceptance test, emits separate SPDX SBOMs, and passes fixed-critical Trivy
   scans.
4. The released commit and production image digests match the reviewed CI
   artifacts.
