#!/usr/bin/env bash
# Brings up the local `kind`-based proof harness for JOB_LAUNCHER=kubernetes:
# a `kind` cluster named `wardby` (context `kind-wardby`), a local registry
# at localhost:5001, and the in-cluster coding proxy. Run from the repo
# root: `bash deploy/kind-coding/up.sh`.
#
# Reads .env.local at run time for DATABASE_URL, OPENAI_API_KEY, and
# ANTHROPIC_API_KEY (only those three names — nothing else in the file is
# sourced or exported) and builds the proxy's Secret manifest itself. The
# values only ever exist as this script's own bash variables and on a
# pipe's stdin into `kubectl apply -f -`; they are never passed as a
# command-line argument to any subprocess (so they never appear in that
# process's argv, which `ps` can read for the process's whole lifetime),
# never echoed, and never written to a tracked file. See
# deploy/kind-coding/README.md.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

MANIFEST_DIR="deploy/kind-coding"
CLUSTER_NAME="wardby"
KUBE_CONTEXT="kind-${CLUSTER_NAME}"
REGISTRY_NAME="kind-registry"
REGISTRY_PORT="5001"
TOTAL_STEPS=10

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

# Reads exactly one variable's value out of .env.local without sourcing the
# file (so nothing else in it is ever exported into this process). Handles
# an optional leading `export `, and a value that's unquoted, single-quoted,
# or double-quoted.
env_value() {
  local name="$1" line raw len
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${name}=" .env.local | tail -n 1)" || true
  if [[ -z "$line" ]]; then
    echo "up.sh: ${name} must be set in .env.local." >&2
    exit 1
  fi
  raw="${line#*=}"
  len=${#raw}
  # bash 3.2 (macOS's default /bin/bash) has no negative-length substring
  # form, hence the explicit `len-2` rather than `${raw:1:-1}`.
  if [[ "$raw" == \"*\" && "$raw" == *\" ]]; then
    raw="${raw:1:len-2}"
  elif [[ "$raw" == \'*\' && "$raw" == *\' ]]; then
    raw="${raw:1:len-2}"
  fi
  printf '%s' "$raw"
}

# base64-encodes one value with no external command ever seeing it in its
# own argv: `printf` here is bash's builtin, not `/usr/bin/printf`, so it
# never becomes a separate process with its own ps-visible command line.
# `base64 | tr -d '\n'` (rather than a `-w0`/`-b0` flag) works identically
# on both GNU (Linux) and BSD (macOS) base64.
b64() {
  printf '%s' "$1" | base64 | tr -d '\n'
}

echo "==> 1/${TOTAL_STEPS} local registry"
if [[ "$(docker inspect -f '{{.State.Running}}' "$REGISTRY_NAME" 2>/dev/null || true)" == "true" ]]; then
  echo "    $REGISTRY_NAME already running"
elif docker inspect "$REGISTRY_NAME" >/dev/null 2>&1; then
  echo "    $REGISTRY_NAME exists but is stopped; starting it"
  docker start "$REGISTRY_NAME" >/dev/null
else
  docker run -d --restart=always -p "127.0.0.1:${REGISTRY_PORT}:5000" --network bridge --name "$REGISTRY_NAME" registry:2
fi

echo "==> 2/${TOTAL_STEPS} kind cluster"
if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
  kind create cluster --config "${MANIFEST_DIR}/kind-config.yaml"
else
  echo "    cluster '$CLUSTER_NAME' already exists"
fi

echo "==> 3/${TOTAL_STEPS} wire the registry into containerd on every node"
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
# Only "already connected" is a benign, idempotent no-op; any other failure
# (e.g. the registry container not existing, a daemon error) must not be
# swallowed.
if ! connect_output="$(docker network connect kind "$REGISTRY_NAME" 2>&1)"; then
  if [[ "$connect_output" != *"already exists"* && "$connect_output" != *"already attached"* ]]; then
    echo "up.sh: docker network connect kind ${REGISTRY_NAME} failed: ${connect_output}" >&2
    exit 1
  fi
fi

echo "==> 4/${TOTAL_STEPS} document the local registry (KEP-1755)"
# kind's documented local-registry recipe: https://kind.sigs.k8s.io/docs/user/local-registry/
cat <<EOF | kubectl --context "$KUBE_CONTEXT" apply -f -
apiVersion: v1
kind: ConfigMap
metadata:
  name: local-registry-hosting
  namespace: kube-public
data:
  localRegistryHosting.v1: |
    host: "localhost:${REGISTRY_PORT}"
    help: "https://kind.sigs.k8s.io/docs/user/local-registry/"
EOF

echo "==> 5/${TOTAL_STEPS} build and push the worker and runtime images"
docker build -f src/coding-worker/Dockerfile -t "localhost:${REGISTRY_PORT}/wardby-coding-worker:dev" .
docker build -f deploy/Dockerfile --target runtime -t "localhost:${REGISTRY_PORT}/wardby-runtime:dev" .
docker push "localhost:${REGISTRY_PORT}/wardby-coding-worker:dev"
docker push "localhost:${REGISTRY_PORT}/wardby-runtime:dev"
WORKER_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "localhost:${REGISTRY_PORT}/wardby-coding-worker:dev")"
RUNTIME_DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "localhost:${REGISTRY_PORT}/wardby-runtime:dev")"

echo "==> 6/${TOTAL_STEPS} verify the worker image has tar, head, and test"
if ! docker run --rm --entrypoint sh "$WORKER_DIGEST" -c 'command -v tar && command -v head && command -v test' >/dev/null; then
  echo "up.sh: worker image $WORKER_DIGEST is missing tar, head, or test; Task 5's seeding and collection depend on them." >&2
  exit 1
fi

echo "==> 7/${TOTAL_STEPS} apply the namespace and the proxy's env Secret"
kubectl --context "$KUBE_CONTEXT" apply -f "${MANIFEST_DIR}/manifests/base/namespace.yaml"

DATABASE_URL="$(env_value DATABASE_URL)"
OPENAI_API_KEY="$(env_value OPENAI_API_KEY)"
ANTHROPIC_API_KEY="$(env_value ANTHROPIC_API_KEY)"
# The proxy runs inside the kind node; the Docker-published local Postgres
# is reachable at host.docker.internal, not localhost/127.0.0.1.
PROXY_DATABASE_URL="${DATABASE_URL/@localhost:/@host.docker.internal:}"
PROXY_DATABASE_URL="${PROXY_DATABASE_URL/@127.0.0.1:/@host.docker.internal:}"

# The Secret manifest is assembled entirely with bash builtins (printf) and
# piped straight into `kubectl apply -f -`; no secret value is ever passed
# as a command-line argument (contrast the previous `--from-literal=...`,
# which put every value in kubectl's argv for the life of the process).
{
  printf 'apiVersion: v1\n'
  printf 'kind: Secret\n'
  printf 'type: Opaque\n'
  printf 'metadata:\n'
  printf '  name: wardby-coding-proxy-env\n'
  printf '  namespace: wardby-coding\n'
  printf 'data:\n'
  printf '  DATABASE_URL: %s\n' "$(b64 "$PROXY_DATABASE_URL")"
  printf '  OPENAI_API_KEY: %s\n' "$(b64 "$OPENAI_API_KEY")"
  printf '  ANTHROPIC_API_KEY: %s\n' "$(b64 "$ANTHROPIC_API_KEY")"
} | kubectl --context "$KUBE_CONTEXT" apply -f -
unset DATABASE_URL OPENAI_API_KEY ANTHROPIC_API_KEY PROXY_DATABASE_URL

echo "==> 8/${TOTAL_STEPS} render and apply the manifests"
kubectl kustomize "${MANIFEST_DIR}/manifests/overlays/kind" \
  | sed "s|image: wardby-runtime|image: ${RUNTIME_DIGEST}|" \
  | kubectl --context "$KUBE_CONTEXT" apply -f -

echo "==> 9/${TOTAL_STEPS} restart the proxy so it picks up the current Secret, then wait for the rollout"
kubectl --context "$KUBE_CONTEXT" -n wardby-coding rollout restart deploy/wardby-coding-proxy
kubectl --context "$KUBE_CONTEXT" -n wardby-coding rollout status deploy/wardby-coding-proxy --timeout=120s

echo "==> 10/${TOTAL_STEPS} done"
cat <<EOF

Add these to .env.local (keep the previous docker-launcher values commented,
not deleted):

JOB_LAUNCHER=kubernetes
KUBERNETES_CONTEXT=${KUBE_CONTEXT}
CODING_WORKER_IMAGE=${WORKER_DIGEST}

Then run:

  npm run cli -- coding preflight
EOF
