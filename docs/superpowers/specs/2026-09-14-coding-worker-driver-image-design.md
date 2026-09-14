# Coding-Worker Driver Base Image — Design

**Date:** 2026-09-14
**Status:** Proposed (design; implementation to proceed inline, no separate plan doc)
**Author:** reevo-run maintainer
**Related:** `src/coding-worker/Dockerfile.node-python` (the pattern this design
extracts a shared layer from); `src/providers/executor/container.ts`
(`resolveCodingWorkerImage`, the existing `workerImageRef` BYO-image path);
`src/coding/profile.ts` (`CodingAgentProfile.workerImageRef`);
`src/mcp/tools/agents.ts` (`create_agent`/`update_agent`, `make_owner` as the
existing scope-step-up precedent); `src/mcp/auth/resource-server.ts`
(`requireScope`/`insufficientScope`).

> **Clean-room note.** This design is grounded entirely in reading reevo-run's
> own source (`container.ts`, `agents.ts`, `Dockerfile.node-python`,
> `resource-server.ts`) plus public Docker/GHCR documentation. It copies no
> external codebase.

---

## Goal

Today, adding support for a new language toolchain (Ruby, PHP, .NET, ...)
means reevo hand-authors a brand-new `Dockerfile.<toolchain>`, each one a
fully separate multi-stage build that recompiles reevo's own TS coding-worker
driver from source. This doesn't scale past a handful of languages reevo is
willing to hand-maintain.

This design publishes a small, versioned, digest-pinned **driver base image**
containing just the compiled Node.js driver (no language runtime). Users
write their own thin Dockerfile on top of it, adding whatever toolchain they
need, and point their `CodingAgentProfile.workerImageRef` at their own built
digest — reusing the BYO-image escape hatch that already exists in
`container.ts` today. This turns "reevo builds every language's image" into
"reevo builds one shared driver layer; users build their own on top of it."

## Non-goals

- Automated re-validation/scanning of a user's final BYO image. The mitigant
  for a compromised/dirty BYO image is (a) the `agents:admin` scope gate below
  and (b) the fact that the high-value guardrails (protected paths, the
  single-commit-per-run invariant, branch/PR scoping, hardened git config)
  live in reevo's own orchestration code (`git.ts`, `container.ts`), not
  inside the worker image — a bad image changes the blast radius of one
  sandboxed job, it cannot bypass those checks.
- A Dockerfile-generator/template script. `Dockerfile.node-python`, refactored
  to consume the driver image, becomes the reference example instead.
- Any change to `src/claude-coding-worker/*` or `src/claude-tool-runner/*`
  beyond the Node 24 base-image bump in §6 — they don't consume the driver
  image and are otherwise out of scope.
- A user/role/workspace model. reevo-run has none today (`Principal` owns
  resources directly; authorization is OAuth scopes per MCP tool call, not
  roles) — this design works within that, it doesn't add one.

---

## 1. Driver image: contents and build

New file: `src/coding-worker/Dockerfile.driver`. It absorbs the `build` and
`worker-dependencies` stages that `Dockerfile.node-python` and
`src/coding-worker/Dockerfile` each currently duplicate:

```dockerfile
FROM node:24.x.x-bookworm-slim@sha256:<resolved at implementation time> AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
COPY scripts ./scripts
COPY src ./src
RUN npm run prisma:generate && npm run build

FROM node:24.x.x-bookworm-slim@sha256:<same digest> AS worker-dependencies
WORKDIR /worker
COPY src/coding-worker/package.json src/coding-worker/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24.x.x-bookworm-slim@sha256:<same digest>
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 --shell /usr/sbin/nologin reevo
WORKDIR /opt/reevo
COPY --from=worker-dependencies /worker/node_modules ./node_modules
COPY --from=build /build/dist/coding-worker ./coding-worker
COPY --from=build /build/dist/coding/protocol.js ./coding/protocol.js
```

Deliberate boundary: the final stage stops here. It does **not** set `USER`,
`WORKDIR /workspace`, or `ENTRYPOINT`, and does not run the
docker/ssh/curl/wget/sudo/gcc/make/pip absence checks. Those depend on what
language toolchain gets layered on — some ecosystems (Ruby native gems, .NET
native interop) legitimately need a compiler, so the hardening assertions
can't be baked into a shared base. They belong in the derived Dockerfile,
which must run them (as root, after installing its toolchain) before
switching to the `reevo` user. `Dockerfile.node-python` (§3) is the worked
example of doing this correctly.

The `ca-certificates`/`git` install and the `reevo` uid/gid (10001) *are*
baked in, since every coding-worker image needs them regardless of language,
and pre-creating the uid keeps file ownership consistent across every image
derived from this base.

## 2. Publish pipeline

New workflow `.github/workflows/publish-driver-image.yml`:

- Trigger: `on: push: tags: ['driver-v*']`. Cutting a `driver-vN` tag is a
  manual maintainer decision (when the driver's own code or Node base
  changes) — there is no automated versioning here.
- Builds `src/coding-worker/Dockerfile.driver`, authenticates to GHCR with
  the built-in `GITHUB_TOKEN` (no new secrets to provision), and pushes to
  `ghcr.io/chfields/reevo-run/reevo-coding-worker-driver` tagged both
  `driver-vN` and `latest`.
- The GHCR package must be set to **public** visibility so downstream builds
  (including CI building `Dockerfile.node-python`, and any BYO user's build)
  can pull it without credentials — the same trust model as pulling
  `node:*-bookworm-slim` from Docker Hub today.
- Resolves the pushed image's digest (`docker buildx imagetools inspect` or
  the build-push-action's `digest` output) and writes it into a GitHub
  Release body for that tag, giving BYO users one canonical place to look up
  "the digest for driver-v3."

This is genuinely new infrastructure: today, no CI in this repo publishes any
image to a registry — `security.yml`'s `worker-image` job only builds images
locally (tagged `:$github.sha`) to run the policy check and acceptance
tests, then discards them. `CODING_WORKER_IMAGE_*` env vars are populated by
whoever deploys reevo, building/pushing images themselves, out of band. This
design does not change that for the *node/node-python* images reevo already
ships — only the new driver image gets a real publish pipeline.

## 3. `Dockerfile.node-python` refactor + Node 24 bump

`Dockerfile.node-python`'s `build`/`worker-dependencies` stages are deleted.
It becomes:

```dockerfile
FROM ghcr.io/chfields/reevo-run/reevo-coding-worker-driver@sha256:<pinned>
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip \
    && python3 -m pip install --no-cache-dir --break-system-packages pytest==8.3.4 ruff==0.16.7 \
    && apt-get purge -y --auto-remove python3-pip \
    && rm -rf /var/lib/apt/lists/*
RUN test ! -e /usr/bin/docker \
    && test ! -e /usr/bin/ssh \
    && test ! -e /usr/bin/curl \
    && test ! -e /usr/bin/wget \
    && test ! -e /usr/bin/sudo \
    && test ! -e /usr/bin/gcc \
    && test ! -e /usr/bin/make \
    && test ! -e /usr/bin/pip \
    && test ! -e /usr/bin/pip3 \
    && python3 -c "import pytest" \
    && python3 -m pytest --version \
    && python3 -m ruff --version
USER 10001:10001
ENV NODE_ENV=production HOME=/home/reevo
WORKDIR /workspace
ENTRYPOINT ["node", "/opt/reevo/coding-worker/main.js"]
```

This file becomes the **reference example** for BYO users — no separate
template is authored; the docs (§5) point here.

Rollout is necessarily two steps, since the digest doesn't exist until the
first publish: (1) merge the driver Dockerfile + publish workflow + this
refactor with a placeholder `FROM` comment, (2) cut `driver-v1`, then a
follow-up commit pins node-python's `FROM` to the real digest.

**Node 24 bump (scope confirmed with the user):** every worker/tool-runner
Dockerfile in the repo currently pins `node:22.22.0-bookworm-slim`, despite
`.nvmrc`/`package.json engines` already targeting Node 24. As part of this
work, `src/coding-worker/Dockerfile`, the new `Dockerfile.driver`,
`Dockerfile.node-python` (via the driver), `src/claude-coding-worker/Dockerfile`,
`src/claude-coding-worker/Dockerfile.compatibility`, and
`src/claude-tool-runner/Dockerfile` all move their `FROM` to the current
Node 24 LTS `bookworm-slim` tag+digest. **The exact patch version and digest
are not fabricated in this doc** — per this repo's own strict-accuracy norm
for hardcoded external facts (see `CLAUDE.md`'s pricing-table rule for the
same principle applied elsewhere), they are resolved for real
(`docker pull node:24-bookworm-slim`, then `docker inspect` for the digest)
as an explicit implementation step, not guessed here.

## 4. Scope-gating: `agents:admin` for `workerImageRef`

reevo-run has no user/role model — authorization is OAuth scopes per MCP
tool call (`agents:read`/`agents:write`/`agents:admin`), already used for
exactly this kind of step-up (`make_owner` requires `agents:admin` while
ordinary CRUD requires only `agents:write`). Since the driver image makes
`workerImageRef` the primary sanctioned path for new toolchains rather than
a rarely-used escape hatch, setting or changing it should require the same
step-up.

- Add `canonicalUri: string` to `McpRequestContext` (`src/mcp/context.ts`),
  populated in `server.ts`'s `resolveCtx` and `fixedContext` branches from
  `opts.config.canonicalUri`. This lets any tool handler call
  `requireScope(ctx, ctx.canonicalUri, ...)` for a field-level check without
  threading extra parameters through — today `requireScope` is only called
  centrally in `server.ts` against a whole tool's declared `scope`.
- In `src/mcp/tools/agents.ts`:
  - `create_agent`: if `codingProfile.workerImageRef` is non-null, call
    `requireScope(ctx, ctx.canonicalUri, "agents:admin")` before persisting.
  - `update_agent`: if the patch object explicitly includes a
    `workerImageRef` key (present at all — touching the field, regardless of
    whether the new value differs from the old one, is the trigger), same
    check.
- This is additive to `agents:write`, not a replacement — a caller still
  needs `agents:write` to call these tools at all (enforced centrally as
  today); `agents:admin` is required in addition, only when touching this
  one field. Setting `toolchain`/`toolchainVersion` from reevo's own curated
  `additionalWorkerImages` matrix is unaffected and stays at `agents:write`.

## 5. Docs & CI policy script

- `scripts/coding-worker-image-policy.mjs` gains a `--kind=driver` mode
  (default remains today's implicit "runtime" behavior, unchanged for
  existing callers) that keeps the digest-pinning, no-mutable-`FROM`/`npm
  install`, and Codex-SDK-pin checks, but skips the `USER 10001:10001` /
  `ENTRYPOINT ["node"` requirements — the driver intentionally has neither.
- `.github/workflows/security.yml`'s `worker-image` matrix gains a
  `dockerfile: src/coding-worker/Dockerfile.driver` entry (tag-suffix
  `driver`), invoking the policy script with `--kind=driver`.
- New `docs/coding-worker-byo-images.md`: explains the driver image, the
  `workerImageRef` mechanism, the `agents:admin` requirement, and points at
  `Dockerfile.node-python` as the worked example to copy from.

## 6. Testing

- `scripts/coding-worker-image-policy.mjs` gets a unit/acceptance check for
  the new `--kind=driver` branch (a fixture Dockerfile missing `USER`/
  `ENTRYPOINT` should pass under `--kind=driver` and fail under the default
  mode, and vice versa for a missing digest pin).
- `src/mcp/tools/agents.test.ts`: new cases — `create_agent` with a
  `workerImageRef` under only `agents:write` is rejected with an
  insufficient-scope error; the same call with `agents:admin` added
  succeeds; `update_agent` patching `workerImageRef` follows the same
  pattern; patching other fields (e.g. `toolchainVersion`) without
  `agents:admin` still succeeds.
- `src/mcp/context.ts` / `server.ts`: existing tests that construct
  `McpRequestContext` fixtures need `canonicalUri` added.
- CI (`security.yml`) build of `Dockerfile.driver` and the refactored
  `Dockerfile.node-python` (which now pulls the driver from GHCR) serves as
  the integration check that the split still produces a working image;
  `test:docker-isolation` continues to run against the plain `Dockerfile`
  build as today.

## Rollout order

1. Add `Dockerfile.driver`, the publish workflow, the policy-script
   `--kind=driver` mode, and the `security.yml` matrix entry.
2. Cut `driver-v1`, confirm the GitHub Release captures a real digest.
3. Refactor `Dockerfile.node-python` to `FROM` that digest; remove its now-
   dead `build`/`worker-dependencies` stages.
4. Bump all six Dockerfiles' Node base to the real, freshly-resolved Node 24
   LTS `bookworm-slim` digest (one commit, so no image is left on a stale
   Node 22 pin mid-rollout).
5. Land the `agents:admin` scope-gating change in `context.ts`/`server.ts`/
   `agents.ts`, with tests.
6. Add `docs/coding-worker-byo-images.md`.

## Open items (deliberately not resolved here)

- Whether `agents:admin` scopes are currently issued to anyone in a real
  deployment, or only ever granted to the same principal as `agents:write`
  (i.e., whether this gate is enforceable in practice today) was not
  verified in-session — worth confirming before relying on it as a real
  boundary in a multi-tenant deployment.
