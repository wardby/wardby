#!/usr/bin/env bash
# TEST ONLY: brings up the release regression suite's Flow G cluster, a kind cluster of its own
# (`wardby-flowg`, context kind-wardby-flowg) beside any other kind cluster, with wardby-sim and
# the coding proxy and native gateway under WARDBY_TEST_SIMULATORS. Images are tagged :flowg in
# the shared local registry so they never replace another cluster's :dev images. The database is
# a private one (wardby_flowg) in the local Postgres; it is dropped and recreated each time.
#
# No real credential goes anywhere: the proxy and gateway get fake provider keys (the switch
# drops credentials on model requests anyway) and the simulator's published test GitHub App key.
#
#   bash deploy/kind-coding/flow-g-up.sh            # from the repo root
#   node scripts/release/flow-g.mjs                 # then run Flow G
#   bash deploy/kind-coding/flow-g-down.sh          # remove the cluster and the database
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

CLUSTER_NAME="wardby-flowg"
KUBE_CONTEXT="kind-${CLUSTER_NAME}"
REGISTRY_NAME="kind-registry"
REGISTRY_PORT="5001"
TAG="flowg"
DB_NAME="wardby_flowg"
PG_CONTAINER="${WARDBY_FLOWG_PG_CONTAINER:-local-postgres-1}"
OUT_DIR="${WARDBY_FLOWG_OUT:-docs/private/flow-g}"
OVERLAY="deploy/kind-coding/manifests/overlays/kind-flow-g"

for bin in kind kubectl docker; do
  command -v "$bin" >/dev/null 2>&1 || { echo "flow-g-up.sh: '$bin' is required." >&2; exit 1; }
done
mkdir -p "$OUT_DIR"

echo "==> 1/8 local registry"
if [[ "$(docker inspect -f '{{.State.Running}}' "$REGISTRY_NAME" 2>/dev/null || true)" != "true" ]]; then
  docker start "$REGISTRY_NAME" >/dev/null 2>&1 ||
    docker run -d --restart=always -p "127.0.0.1:${REGISTRY_PORT}:5000" --network bridge --name "$REGISTRY_NAME" registry:2
fi

echo "==> 2/8 kind cluster ${CLUSTER_NAME}"
if ! kind get clusters 2>/dev/null | grep -qx "$CLUSTER_NAME"; then
  sed "s/^name: wardby$/name: ${CLUSTER_NAME}/" deploy/kind-coding/kind-config.yaml >"$OUT_DIR/kind-config.yaml"
  grep -qx "name: ${CLUSTER_NAME}" "$OUT_DIR/kind-config.yaml" || { echo "flow-g-up.sh: could not rename the cluster" >&2; exit 1; }
  kind create cluster --config "$OUT_DIR/kind-config.yaml"
fi
while IFS= read -r node; do
  docker exec "$node" mkdir -p "/etc/containerd/certs.d/localhost:${REGISTRY_PORT}"
  printf '[host."http://%s:5000"]\n' "$REGISTRY_NAME" | docker exec -i "$node" cp /dev/stdin "/etc/containerd/certs.d/localhost:${REGISTRY_PORT}/hosts.toml"
done < <(kind get nodes --name "$CLUSTER_NAME")
docker network connect kind "$REGISTRY_NAME" >/dev/null 2>&1 || true

echo "==> 3/8 private database ${DB_NAME}"
docker exec "$PG_CONTAINER" psql -U wardby -d wardby -q -c "DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);" -c "CREATE DATABASE ${DB_NAME};" >/dev/null
HOST_DATABASE_URL="postgresql://wardby:wardby@localhost:55432/${DB_NAME}"
CLUSTER_DATABASE_URL="postgresql://wardby:wardby@host.docker.internal:55432/${DB_NAME}"
DATABASE_URL="$HOST_DATABASE_URL" npx prisma migrate deploy >/dev/null
DATABASE_URL="$HOST_DATABASE_URL" npx dbos schema "$HOST_DATABASE_URL" >/dev/null 2>&1 || true

echo "==> 4/8 build and push the :${TAG} images"
build() { docker build -q "$@" >/dev/null; }
build -f tools/wardby-sim/Dockerfile -t "localhost:${REGISTRY_PORT}/wardby-sim:${TAG}" .
build -f deploy/Dockerfile --target runtime --build-arg WARDBY_TEST_SIMULATORS_ALLOWED=1 -t "localhost:${REGISTRY_PORT}/wardby-runtime:${TAG}" .
build -f src/coding-worker/Dockerfile -t "localhost:${REGISTRY_PORT}/wardby-coding-worker:${TAG}" .
build -f src/claude-coding-worker/Dockerfile -t "localhost:${REGISTRY_PORT}/wardby-claude-coding-worker:${TAG}" .
build -f src/claude-tool-runner/Dockerfile -t "localhost:${REGISTRY_PORT}/wardby-claude-tool-runner:${TAG}" .
for image in wardby-sim wardby-runtime wardby-coding-worker wardby-claude-coding-worker wardby-claude-tool-runner; do
  docker push -q "localhost:${REGISTRY_PORT}/${image}:${TAG}" >/dev/null
done
digest() { docker inspect --format '{{index .RepoDigests 0}}' "localhost:${REGISTRY_PORT}/$1:${TAG}"; }
SIM_DIGEST="$(digest wardby-sim)"
RUNTIME_DIGEST="$(digest wardby-runtime)"

echo "==> 5/8 namespaces and the proxy's and gateway's env (fake keys only)"
kubectl --context "$KUBE_CONTEXT" apply -f deploy/kind-coding/manifests/base/namespace.yaml >/dev/null
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
SIM_KEY_B64="$(base64 <tools/wardby-sim/fixtures/github-app-test-key.pem | tr -d '\n')"
{
  printf 'apiVersion: v1\nkind: Secret\ntype: Opaque\nmetadata:\n  name: wardby-coding-proxy-env\n  namespace: wardby-coding\ndata:\n'
  printf '  DATABASE_URL: %s\n' "$(b64 "$CLUSTER_DATABASE_URL")"
  printf '  OPENAI_API_KEY: %s\n' "$(b64 sk-flowg-fake-openai-key)"
  printf '  ANTHROPIC_API_KEY: %s\n' "$(b64 sk-ant-flowg-fake-anthropic-key)"
} | kubectl --context "$KUBE_CONTEXT" apply -f - >/dev/null
{
  printf 'apiVersion: v1\nkind: Secret\ntype: Opaque\nmetadata:\n  name: wardby-native-gateway-env\n  namespace: wardby-coding\ndata:\n'
  printf '  DATABASE_URL: %s\n' "$(b64 "$CLUSTER_DATABASE_URL")"
  printf '  OPENAI_API_KEY: %s\n' "$(b64 sk-flowg-fake-openai-key)"
  printf '  ANTHROPIC_API_KEY: %s\n' "$(b64 sk-ant-flowg-fake-anthropic-key)"
  printf "  SECRET_APP_KEY: %s\n" "$(b64 "$(printf "f%.0s" {1..64})")"
  printf '  GITHUB_APP_ID: %s\n' "$(b64 424242)"
  printf '  GITHUB_APP_PRIVATE_KEY: %s\n' "$SIM_KEY_B64"
} | kubectl --context "$KUBE_CONTEXT" apply -f - >/dev/null

echo "==> 6/8 the simulator"
sed "s|image: localhost:5001/wardby-sim:dev|image: ${SIM_DIGEST}|" deploy/kind-coding/sim.yaml |
  kubectl --context "$KUBE_CONTEXT" apply -f - >/dev/null
# Its throwaway CA: https on 8443 (the control plane's git only speaks https).
KUBE_CONTEXT="$KUBE_CONTEXT" bash deploy/kind-coding/sim-ca.sh "$OUT_DIR/ca" --apply >/dev/null
kubectl --context "$KUBE_CONTEXT" -n wardby-sim rollout restart deploy/wardby-sim >/dev/null
kubectl --context "$KUBE_CONTEXT" -n wardby-sim rollout status deploy/wardby-sim --timeout=180s

echo "==> 7/8 the coding proxy and native gateway (overlay kind-flow-g)"
kubectl kustomize "$OVERLAY" | sed "s|image: wardby-runtime|image: ${RUNTIME_DIGEST}|" |
  kubectl --context "$KUBE_CONTEXT" apply -f - >/dev/null
kubectl --context "$KUBE_CONTEXT" -n wardby-coding rollout restart deploy/wardby-coding-proxy deploy/wardby-native-gateway >/dev/null
kubectl --context "$KUBE_CONTEXT" -n wardby-coding rollout status deploy/wardby-coding-proxy --timeout=180s
kubectl --context "$KUBE_CONTEXT" -n wardby-coding rollout status deploy/wardby-native-gateway --timeout=180s

echo "==> 8/8 the control plane's environment: ${OUT_DIR}/control-plane.env"
cat >"$OUT_DIR/control-plane.env" <<EOF
DATABASE_URL=${HOST_DATABASE_URL}
JOB_LAUNCHER=kubernetes
KUBERNETES_CONTEXT=${KUBE_CONTEXT}
CODING_WORKER_IMAGE=$(digest wardby-coding-worker)
CODING_CLAUDE_WORKER_IMAGE=$(digest wardby-claude-coding-worker)
CODING_CLAUDE_TOOL_RUNNER_IMAGE=$(digest wardby-claude-tool-runner)
KUBERNETES_ENFORCEMENT_EXEC_TIMEOUT_MS=60000
WARDBY_SIM_CA_FILE=${ROOT_DIR}/${OUT_DIR}/ca/ca.crt
NODE_EXTRA_CA_CERTS=${ROOT_DIR}/${OUT_DIR}/ca/ca.crt
EOF
echo "flow-g-up.sh: ready (context ${KUBE_CONTEXT})."
