# Every image deploy/gke/up.sh deploys, built in one `docker buildx bake` run so they build
# concurrently and share one build context. Run from the repository root:
#
#   REGISTRY=<artifact-registry-url> docker buildx bake -f deploy/gke/docker-bake.hcl --load
#
# All images target linux/amd64 (GKE nodes). Stages that only compile JavaScript are declared
# `FROM --platform=$BUILDPLATFORM` in their Dockerfiles, so on an arm64 machine they run natively
# instead of under emulation; everything that ships is still built for linux/amd64.

variable "REGISTRY" {}

group "default" {
  targets = [
    "runtime",
    "migration",
    "coding-worker",
    "coding-worker-node-python",
    "coding-worker-node-python-3-13",
    "coding-worker-node-python-3-14",
    "claude-coding-worker",
    "claude-tool-runner",
    "claude-tool-runner-node-python",
    "claude-tool-runner-node-python-3-13",
    "claude-tool-runner-node-python-3-14",
    "native-worker",
  ]
}

target "_gke" {
  context   = "."
  platforms = ["linux/amd64"]
}

target "runtime" {
  inherits   = ["_gke"]
  dockerfile = "deploy/Dockerfile"
  target     = "runtime"
  tags       = ["${REGISTRY}/runtime:latest"]
}

target "migration" {
  inherits   = ["_gke"]
  dockerfile = "deploy/Dockerfile"
  target     = "migration"
  tags       = ["${REGISTRY}/migration:latest"]
}

target "coding-worker" {
  inherits   = ["_gke"]
  dockerfile = "src/coding-worker/Dockerfile"
  tags       = ["${REGISTRY}/coding-worker:latest"]
}

target "coding-worker-node-python" {
  inherits   = ["_gke"]
  dockerfile = "src/coding-worker/Dockerfile.node-python"
  args       = { PYTHON_DEFAULT_VERSION = "3.12" }
  tags       = ["${REGISTRY}/coding-worker-node-python:latest"]
}

# `python` in a node-python image is the version it is built for (PYTHON_DEFAULT_VERSION, 3.12 by
# default), so each toolchainVersion has its own image.
target "coding-worker-node-python-3-13" {
  inherits   = ["coding-worker-node-python"]
  args       = { PYTHON_DEFAULT_VERSION = "3.13" }
  tags       = ["${REGISTRY}/coding-worker-node-python-3-13:latest"]
}

target "coding-worker-node-python-3-14" {
  inherits   = ["coding-worker-node-python"]
  args       = { PYTHON_DEFAULT_VERSION = "3.14" }
  tags       = ["${REGISTRY}/coding-worker-node-python-3-14:latest"]
}

target "claude-coding-worker" {
  inherits   = ["_gke"]
  dockerfile = "src/claude-coding-worker/Dockerfile"
  tags       = ["${REGISTRY}/claude-coding-worker:latest"]
}

target "claude-tool-runner" {
  inherits   = ["_gke"]
  dockerfile = "src/claude-tool-runner/Dockerfile"
  tags       = ["${REGISTRY}/claude-tool-runner:latest"]
}

target "claude-tool-runner-node-python" {
  inherits   = ["_gke"]
  dockerfile = "src/claude-tool-runner/Dockerfile"
  target     = "node-python"
  args       = { PYTHON_DEFAULT_VERSION = "3.12" }
  tags       = ["${REGISTRY}/claude-tool-runner-node-python:latest"]
}

target "claude-tool-runner-node-python-3-13" {
  inherits = ["claude-tool-runner-node-python"]
  args     = { PYTHON_DEFAULT_VERSION = "3.13" }
  tags     = ["${REGISTRY}/claude-tool-runner-node-python-3-13:latest"]
}

target "claude-tool-runner-node-python-3-14" {
  inherits = ["claude-tool-runner-node-python"]
  args     = { PYTHON_DEFAULT_VERSION = "3.14" }
  tags     = ["${REGISTRY}/claude-tool-runner-node-python-3-14:latest"]
}

# The native sandbox worker (docs/native-sandbox.md): sandbox-mode native agents run in it, one pod
# per run, reaching only the native gateway.
target "native-worker" {
  inherits   = ["_gke"]
  dockerfile = "src/native-worker/Dockerfile"
  tags       = ["${REGISTRY}/native-worker:latest"]
}

# The optional PNG/PDF export renderer (docs/documents.md, "Exports"). Not in the default group:
# `docker buildx bake -f deploy/gke/docker-bake.hcl renderer` builds it, and deploy/gke/up.sh does so
# only when WARDBY_RENDERER=true.
target "renderer" {
  inherits   = ["_gke"]
  dockerfile = "deploy/Dockerfile"
  target     = "renderer"
  tags       = ["${REGISTRY}/renderer:latest"]
}

# The rootless Docker daemon for `docker` coding services (docs/coding-services.md, "Docker services").
# Not in the default group, since only a service catalog entry uses it:
# `docker buildx bake -f deploy/gke/docker-bake.hcl docker-service` builds it.
target "docker-service" {
  inherits   = ["_gke"]
  dockerfile = "src/docker-service/Dockerfile"
  tags       = ["${REGISTRY}/docker-service:latest"]
}
