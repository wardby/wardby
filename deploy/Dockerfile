FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY prisma ./prisma
COPY scripts ./scripts
COPY src ./src
COPY tsconfig.json tsconfig.build.json ./
RUN npm run prisma:generate && npm run build

FROM build AS migration
CMD ["npm", "run", "prisma:migrate"]

FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS runtime
WORKDIR /app
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
RUN npm pkg delete devDependencies scripts \
    && npm install --package-lock-only --omit=peer --ignore-scripts \
    && npm ci --omit=peer --ignore-scripts \
    && npm cache clean --force
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist
RUN test ! -d node_modules/prisma && test ! -d node_modules/@prisma/config && test ! -d node_modules/deepmerge-ts
USER node
ENV NODE_ENV=production
# The complete process: MCP + scheduler + reconciler. A deployment that
# splits them (deploy/production/compose.yml) overrides this per container.
CMD ["node", "dist/cli.js", "serve"]
