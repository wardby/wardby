#!/usr/bin/env bash
# Brings up the local `kind`-based proof harness for JOB_LAUNCHER=kubernetes:
# a `kind` cluster named `wardby` (context `kind-wardby`), a local registry
# at localhost:5001, and the in-cluster coding proxy. Run from the repo
# root: `bash deploy/kind-coding/up.sh`.
#
# Reads .env.local at run time for DATABASE_URL, OPENAI_API_KEY, and
# ANTHROPIC_API_KEY, and passes them straight into a Kubernetes Secret
# without ever printing them or writing them to a tracked file. See
# deploy/kind-coding/README.md.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

MANIFEST_DIR="deploy/kind-coding"
CLUSTER_NAME="wardby"
KUBE_CONTEXT="kind-${CLUSTER_NAME}"
REGISTRY_NAME="kind-registry"
REGISTRY_PORT="5001"

for bin in kind kubectl docker; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "up.sh: '$bin' is required but not found on PATH." >&2
    exit 1
  fi
done

if [[ ! -f .env.local ]]; then
  echo "up.sh: .env.local not found at repo root; create it before running up.sh." >&2
  exit 1
fi

echo "==> 1/8 local registry"
if [[ "$(docker inspect -f '{{.State.Running}}' "$REGISTRY_NAME" 2>/dev/null || true)" != "true" ]]; then
  docker run -d --restart=always -p "127.0.0.1:${REGISTRY_PORT}:5000" --network bridge --name "$REGISTRY_NAME" registry:2
else
  echo "    $REGISTRY_NAME already running"
fi

echo "==> 2/8 kind cluster"
if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
  kind create cluster --config "${MANIFEST_DIR}/kind-config.yaml"
else
  echo "    cluster '$CLUSTER_NAME' already exists"
fi

echo "==> 3/8 wire the registry into containerd on every node"
while IFS= read -r node; do
  docker exec "$node" mkdir -p "/etc/containerd/certs.d/localhost:${REGISTRY_PORT}"
  cat <<EOF | docker exec -i "$node" cp /dev/stdin "/etc/containerd/certs.d/localhost:${REGISTRY_PORT}/hosts.toml"
[host."http://${REGISTRY_NAME}:5000"]
EOF
done < <(kind get nodes --name "$CLUSTER_NAME")

if ! docker network inspect kind >/dev/null 2>&1; then
  echo "up.sh: expected a docker network named 'kind' to exist after 'kind create cluster'." >&2
  exit 1
fi
docker network connect kind "$REGISTRY_NAME" 2>/dev/null || true

echo "==> 4/8 build and push the worker and runtime images"
docker build -f src/coding-worker/Dockerfile -t "localhost:${REGISTRY_PORT}/wardby-coding-worker:dev" .
docker build -f deploy/Dockerfile --target runtime -t "localhost:${REGISTRY_PORT}/wardby-runtime:dev" .
docker push "localhost:${REGISTRY_PORT}/wardby-coding-worker:dev"
docker push "localhost:${REGISTRY_PORT}/wardby-runtime:dev"
WORKER_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "localhost:${REGISTRY_PORT}/wardby-coding-worker:dev")"
RUNTIME_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "localhost:${REGISTRY_PORT}/wardby-runtime:dev")"

echo "==> 5/8 verify the worker image has tar, head, and test"
if ! docker run --rm --entrypoint sh "$WORKER_DIGEST" -c 'command -v tar && command -v head && command -v test' >/dev/null; then
  echo "up.sh: worker image $WORKER_DIGEST is missing tar, head, or test; Task 5's seeding and collection depend on them." >&2
  exit 1
fi

echo "==> 6/8 apply the namespace and the proxy's env Secret"
kubectl --context "$KUBE_CONTEXT" apply -f "${MANIFEST_DIR}/manifests/base/namespace.yaml"

# Values are read straight from .env.local into environment variables and
# piped into kubectl; they are never echoed, never interpolated into a
# shell string kubectl could log, and never written to a tracked file.
set -a
# shellcheck disable=SC1091
source .env.local
set +a
: "${DATABASE_URL:?DATABASE_URL must be set in .env.local}"
: "${OPENAI_API_KEY:?OPENAI_API_KEY must be set in .env.local}"
: "${ANTHROPIC_API_KEY:?ANTHROPIC_API_KEY must be set in .env.local}"
# The proxy runs inside the kind node; the Docker-published local Postgres
# is reachable at host.docker.internal, not localhost/127.0.0.1.
PROXY_DATABASE_URL="${DATABASE_URL/@localhost:/@host.docker.internal:}"
PROXY_DATABASE_URL="${PROXY_DATABASE_URL/@127.0.0.1:/@host.docker.internal:}"

kubectl --context "$KUBE_CONTEXT" -n wardby-coding create secret generic wardby-coding-proxy-env \
  --from-literal="DATABASE_URL=${PROXY_DATABASE_URL}" \
  --from-literal="OPENAI_API_KEY=${OPENAI_API_KEY}" \
  --from-literal="ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}" \
  --dry-run=client -o yaml | kubectl --context "$KUBE_CONTEXT" apply -f -
unset DATABASE_URL OPENAI_API_KEY ANTHROPIC_API_KEY PROXY_DATABASE_URL

echo "==> 7/8 render and apply the manifests, then wait for the proxy rollout"
kubectl kustomize "${MANIFEST_DIR}/manifests/overlays/kind" \
  | sed "s|image: wardby-runtime|image: ${RUNTIME_DIGEST}|" \
  | kubectl --context "$KUBE_CONTEXT" apply -f -
kubectl --context "$KUBE_CONTEXT" -n wardby-coding rollout status deploy/wardby-coding-proxy --timeout=120s

echo "==> 8/8 done"
cat <<EOF

Add these to .env.local (keep the previous docker-launcher values commented,
not deleted):

JOB_LAUNCHER=kubernetes
KUBERNETES_CONTEXT=${KUBE_CONTEXT}
CODING_WORKER_IMAGE=${WORKER_DIGEST}

Then run:

  npm run cli -- coding preflight
EOF
