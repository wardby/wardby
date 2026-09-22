#!/usr/bin/env bash
# Tears down the local `kind` harness: the cluster and the local registry.
# Both steps tolerate absence (safe to run repeatedly, or when up.sh never
# finished). Run from the repo root: `bash deploy/kind-coding/down.sh`.
set -euo pipefail

CLUSTER_NAME="wardby"
REGISTRY_NAME="kind-registry"

kind delete cluster --name "$CLUSTER_NAME" || true
docker rm -f "$REGISTRY_NAME" >/dev/null 2>&1 || true
