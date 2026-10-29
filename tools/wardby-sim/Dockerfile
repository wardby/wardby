# wardby-sim: TEST ONLY. A stateful simulator of GitHub, Slack, the package registries and
# Jira for the release regression suite. Never push this image to a production registry,
# and never deploy it outside a throwaway test cluster (deploy/kind-coding/sim.yaml).
#
# Build from the repo root:
#   docker build -f tools/wardby-sim/Dockerfile -t localhost:5001/wardby-sim:dev .
FROM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4 AS build
WORKDIR /build
# The simulator uses only Node built-ins; esbuild (the repo's pinned version) bundles it.
RUN npm install --no-save esbuild@0.28.2
COPY tools/wardby-sim/src ./src
RUN npx esbuild src/main.ts --bundle --platform=node --format=esm --target=node24 --outfile=dist/main.mjs

FROM node:24.22.0-bookworm-slim@sha256:91acba91b842bec0bf7ea6f5e09c644c7ccad72c4996ed9616d861d1c7cd60d4
# git http-backend serves the simulated repositories; wardby's merge-tree needs git >= 2.38,
# so the build fails on anything older.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && git --version \
  && git --version | awk '{ split($3, v, "."); if (v[1] < 2 || (v[1] == 2 && v[2] < 38)) { print "git >= 2.38 required, got " $3; exit 1 } }'
WORKDIR /sim
COPY --from=build /build/dist/main.mjs ./main.mjs
ENV WARDBY_SIM_PORT=8080 WARDBY_SIM_GIT_ROOT=/var/lib/wardby-sim/git
RUN mkdir -p /var/lib/wardby-sim/git && chown -R node:node /var/lib/wardby-sim
USER node
EXPOSE 8080
CMD ["node", "/sim/main.mjs"]
