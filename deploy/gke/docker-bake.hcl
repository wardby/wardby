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
    "claude-coding-worker",
    "claude-tool-runner",
    "claude-tool-runner-node-python",
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
  tags       = ["${REGISTRY}/coding-worker-node-python:latest"]
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
  tags       = ["${REGISTRY}/claude-tool-runner-node-python:latest"]
}

# The native sandbox worker (docs/native-sandbox.md): sandbox-mode native agents run in it, one pod
# per run, reaching only the native gateway.
target "native-worker" {
  inherits   = ["_gke"]
  dockerfile = "src/native-worker/Dockerfile"
  tags       = ["${REGISTRY}/native-worker:latest"]
}
