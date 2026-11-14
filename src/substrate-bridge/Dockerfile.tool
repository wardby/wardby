# The tool-runner image plus the Substrate bridge as entrypoint (build context: the repository root,
# after `npm run build`). BASE is the tool-runner image (src/claude-tool-runner/Dockerfile).
ARG BASE
FROM ${BASE}
USER root
RUN mkdir -p /run/wardby/tool /workspace \
    && chown -R 10001:10001 /run/wardby /workspace
COPY dist/substrate-bridge/ /opt/wardby/substrate-bridge/
RUN printf '{"type":"module"}\n' > /opt/wardby/substrate-bridge/package.json
USER 10001:10001
ENTRYPOINT ["node", "/opt/wardby/substrate-bridge/tool.js"]
