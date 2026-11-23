# The rootless Docker daemon behind the `docker` coding-service kind (docs/coding-services.md, "Docker
# services"): one per run that declares it, as a sidecar in the Kubernetes run pod under gVisor. wardby
# sets the daemon's arguments, environment, socket and security context; this image only adds the run's
# user (uid and gid 10001, CODING_WORKER_UID) and the subordinate id range rootlesskit maps it into.
FROM docker:29.10.0-dind-rootless@sha256:5a703ad0d72cd5e4fb4beca8024d6eddef6d22a46ed1d9812bf3d24ff43ccbce
LABEL org.opencontainers.image.source="https://github.com/wardby/wardby"
USER root
RUN echo 'wardby:x:10001:10001:wardby:/home/wardby:/bin/sh' >> /etc/passwd \
    && echo 'wardby:x:10001:' >> /etc/group \
    && echo 'wardby:100000:65536' >> /etc/subuid \
    && echo 'wardby:100000:65536' >> /etc/subgid \
    && test -x /usr/bin/newuidmap && test -x /usr/bin/newgidmap \
    && command -v dockerd-entrypoint.sh
USER 10001:10001
