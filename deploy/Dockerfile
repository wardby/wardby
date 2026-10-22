# The build stage runs on the builder's own platform ($BUILDPLATFORM): its output (dist/, the
# generated Prisma client, the help index) is plain JavaScript, so an arm64 machine building the
# linux/amd64 images compiles natively instead of under emulation. Every stage that ships or runs
# on the cluster (runtime, migration) stays on the target platform.
FROM --platform=$BUILDPLATFORM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY prisma ./prisma
COPY scripts ./scripts
COPY help ./help
COPY src ./src
COPY tsconfig.json tsconfig.build.json prisma.config.ts ./
# build runs prisma generate (into src/generated/prisma) before tsc, so the
# client ships compiled inside dist/generated/prisma.
RUN npm run build

# The migration image needs the Prisma CLI (a devDependency) and prisma.config.ts, which Prisma 7
# needs for the schema, migrations path and DATABASE_URL. It runs on the cluster, so it is built
# for the target platform rather than from the (builder-platform) build stage.
FROM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 AS migration
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# Same openai src/ + *.map prune as the runtime stage below (see the reasoning
# there); this image never loads openai at all, so it is size only.
RUN npm ci --ignore-scripts \
    && rm -rf node_modules/openai/src \
    && find node_modules/openai -type f -name '*.map' -delete \
    && test -f node_modules/openai/index.mjs && test ! -d node_modules/openai/src \
    && test -z "$(find node_modules/openai -name '*.map' -print -quit)"
COPY prisma ./prisma
COPY prisma.config.ts ./
# DATABASE_AUTH=rds-iam: the migration Job mints its DATABASE_URL with this (see scripts/rds-iam-url.mjs).
COPY scripts/rds-iam-url.mjs ./scripts/rds-iam-url.mjs
# npm ci ran with --ignore-scripts, so Prisma's schema engine (which `migrate deploy` needs) isn't
# installed yet. The migration Job runs as a non-root user on a read-only root filesystem, where
# the CLI can't fetch it on first use, so fetch it here, for this image's platform.
RUN npx prisma generate
CMD ["npm", "run", "prisma:migrate"]

FROM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 AS runtime
WORKDIR /app
# Images are release images by default: they refuse the test-only WARDBY_TEST_SIMULATORS
# switch (src/config/test-simulators.ts). Only a throwaway test cluster's build passes
# --build-arg WARDBY_TEST_SIMULATORS_ALLOWED=1.
ARG WARDBY_TEST_SIMULATORS_ALLOWED=0
ENV WARDBY_TEST_SIMULATORS_ALLOWED=${WARDBY_TEST_SIMULATORS_ALLOWED}
# git is not optional here: the coding executor prepares every run's workspace by
# shelling out to the git binary (clone, commit, push) before the worker pod is
# ever created, so without it every coding run is refused with
# git_command_failed:spawn:git_spawn_failed. This went unnoticed until the
# control plane ran from this image for the first time (2026-09-23): the Cloud
# Run deployment has no job launcher, so its coding runs failed closed earlier
# for an unrelated reason, and every other run so far used a developer's own
# machine, where git is simply present.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates git && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# openai@7 ships its TypeScript sources (src/, ~5.7 MB) and source maps (*.map,
# ~10 MB) inside the package. Neither is loaded at runtime: the package's
# exports map resolves only the compiled .js/.mjs files, nothing outside src/
# imports from src/, and the control plane runs without --enable-source-maps.
# Pruning them in the same layer as the install keeps them out of the image
# entirely (a later RUN would only hide them under a whiteout).
RUN npm pkg delete dependencies.prisma devDependencies scripts \
    && npm install --package-lock-only --omit=peer --ignore-scripts \
    && npm ci --omit=peer --ignore-scripts \
    && npm cache clean --force \
    && rm -rf node_modules/openai/src \
    && find node_modules/openai -type f -name '*.map' -delete
# The generated Prisma client is part of dist/ (dist/generated/prisma, reached
# through package.json's "#prisma" import); only @prisma/client's runtime and
# the pg adapter come from node_modules.
COPY --from=build /app/dist ./dist
# git.ts resolves this relative to its own module URL (dist/providers/vcs ->
# ../../../scripts), and git runs it as GIT_ASKPASS to receive the GitHub App
# token. Without it a coding run gets all the way through the agent's work --
# paying for it -- and then cannot push: "cannot run
# /app/scripts/git-askpass.sh: No such file or directory", followed by git
# asking for a username on a terminal that does not exist. Measured on the first
# hosted run that reached the push, 2026-09-23. Only this one script is copied:
# everything else under scripts/ is development tooling that has no business in
# a runtime image.
COPY --from=build /app/scripts/git-askpass.sh ./scripts/git-askpass.sh
RUN test -x scripts/git-askpass.sh && test ! -d node_modules/prisma && test ! -d node_modules/@prisma/config && test ! -d node_modules/deepmerge-ts && test ! -d node_modules/mysql2 \
    && test -f dist/generated/prisma/client.js && test -d node_modules/@prisma/adapter-pg \
    && test -f node_modules/openai/index.mjs && test ! -d node_modules/openai/src \
    && test -z "$(find node_modules/openai -name '*.map' -print -quit)" \
    && node --input-type=module -e 'import OpenAI from "openai"; new OpenAI({ apiKey: "build-check" });'
# The run dependency cache's local blob directory (BLOB_STORE=local). A named volume
# mounted here takes this directory's ownership, so the non-root user can write it.
RUN mkdir -p /var/lib/wardby/blobs && chown node:node /var/lib/wardby/blobs
USER node
ENV NODE_ENV=production
# The complete process: MCP + scheduler + reconciler. A deployment that
# splits them (deploy/production/compose.yml) overrides this per container.
CMD ["node", "dist/cli.js", "serve"]
