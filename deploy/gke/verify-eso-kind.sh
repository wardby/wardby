#!/usr/bin/env bash
#
# Proves the External Secrets setup on a throwaway kind cluster, using ESO's
# fake provider in place of Google Secret Manager (kind has no Workload
# Identity). Checks, against the committed manifests and values:
#
#   1. The two ExternalSecrets sync, with AUTH_PROVIDER merged in, after a
#      pre-existing hand-made Secret is handed over by release_unowned_secrets.
#   2. ESO does nothing outside wardby-coding.
#   3. ESO's service account cannot write Secrets in another namespace.
#   4. wait_external_secrets_ready fails with a readable reason for a key that
#      does not exist.
#
# Uses a private KUBECONFIG so this never touches the caller's current
# kubectl context (which may point at a live GKE cluster), and deletes the
# kind cluster and the temp kubeconfig on exit, even on failure.
# Needs kind, kubectl and helm.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
source deploy/gke/eso.env
source deploy/gke/lib-secrets.sh

CLUSTER="wardby-eso-check"
export KUBECONFIG="$(mktemp -t wardby-eso-kubeconfig)"
export KUBE_CONTEXT="kind-${CLUSTER}"
export NAMESPACE="wardby-coding"
SECRETS_DIR="deploy/kind-coding/manifests/overlays/gke-autopilot/secrets"
REASON_FILE="$(mktemp -t wardby-eso-check-reason)"
k() { kubectl --context "$KUBE_CONTEXT" "$@"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

cleanup() {
  kind delete cluster --name "$CLUSTER" --kubeconfig "$KUBECONFIG" >/dev/null 2>&1 || true
  rm -f "$KUBECONFIG" "$REASON_FILE"
}
trap cleanup EXIT

kind create cluster --name "$CLUSTER" --kubeconfig "$KUBECONFIG" --wait 120s >/dev/null
k create namespace "$NAMESPACE" >/dev/null
k create namespace other >/dev/null

echo "==> install ESO ${ESO_CHART_VERSION}, scoped"
helm upgrade --install external-secrets external-secrets --repo "$ESO_CHART_REPO" \
  --version "$ESO_CHART_VERSION" --kube-context "$KUBE_CONTEXT" \
  --namespace external-secrets --create-namespace \
  --values deploy/gke/eso-values.yaml --wait --timeout 5m >/dev/null

# A fake store holding a dummy value for every key the real manifests reference.
fake_store() {
  local ns="$1"
  {
    printf 'apiVersion: external-secrets.io/v1\nkind: SecretStore\nmetadata:\n  name: gcp-secret-manager\n  namespace: %s\n' "$ns"
    printf 'spec:\n  provider:\n    fake:\n      data:\n'
    for id in database-url openai-api-key anthropic-api-key secret-app-key github-app-id \
      github-app-private-key auth-signing-key auth-credential-hash-key; do
      printf '        - key: test-%s\n          value: dummy-%s\n' "$id" "$id"
    done
  } | k apply -f - >/dev/null
}
# The committed ExternalSecrets with the prefix placeholder set to "test".
real_external_secrets() {
  sed -e 's|wardby-secret-prefix|test|g' -e "s|namespace: wardby-coding|namespace: $1|" \
    "$SECRETS_DIR/external-secrets.yaml"
}

echo "==> 1. hand over a pre-existing Secret and sync"
fake_store "$NAMESPACE"
k -n "$NAMESPACE" create secret generic wardby-control-plane-env --from-literal=STALE=1 >/dev/null
real_external_secrets "$NAMESPACE" | k apply -f - >/dev/null
sleep 20
if k -n "$NAMESPACE" get secret wardby-control-plane-env -o jsonpath='{.metadata.ownerReferences[*].kind}' | grep -q ExternalSecret; then
  echo "    observed: ESO adopted the unowned Secret by itself"
else
  echo "    observed: ESO left the unowned Secret alone; release_unowned_secrets is required"
fi
release_unowned_secrets wardby-coding-proxy-env wardby-control-plane-env
wait_external_secrets_ready 120s wardby-coding-proxy-env wardby-control-plane-env || fail "ExternalSecrets not Ready"
decoded() { k -n "$NAMESPACE" get secret wardby-control-plane-env -o "jsonpath={.data.$1}" | base64 -d; }
[[ "$(decoded AUTH_PROVIDER)" == "self-hosted" ]] || fail "AUTH_PROVIDER not merged"
[[ "$(decoded SECRET_APP_KEY)" == "dummy-secret-app-key" ]] || fail "SECRET_APP_KEY not synced"
[[ -z "$(decoded STALE)" ]] || fail "stale key survived the handover"
echo "    ok"

echo "==> 2. nothing syncs outside wardby-coding"
fake_store other
real_external_secrets other | k apply -f - >/dev/null
sleep 20
if k -n other get secret wardby-control-plane-env >/dev/null 2>&1; then fail "ESO wrote a Secret in namespace other"; fi
echo "    ok"

echo "==> 3. ESO cannot write Secrets elsewhere"
ESO_SA_NAME="$(k -n external-secrets get deploy external-secrets -o jsonpath='{.spec.template.spec.serviceAccountName}')"
ESO_SA="system:serviceaccount:external-secrets:${ESO_SA_NAME}"
[[ "$(k auth can-i create secrets -n other --as "$ESO_SA")" == "no" ]] || fail "ESO can create Secrets in other"
[[ "$(k auth can-i create secrets -n "$NAMESPACE" --as "$ESO_SA")" == "yes" ]] || fail "ESO cannot create Secrets in wardby-coding"
echo "    ok"

echo "==> 4. a missing key fails the wait with a reason"
cat <<EOF | k apply -f - >/dev/null
apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata:
  name: missing-key-check
  namespace: ${NAMESPACE}
spec:
  secretStoreRef: {kind: SecretStore, name: gcp-secret-manager}
  target: {name: missing-key-check}
  data:
    - secretKey: X
      remoteRef: {key: does-not-exist}
EOF
if wait_external_secrets_ready 30s missing-key-check 2>"$REASON_FILE"; then fail "wait succeeded for a missing key"; fi
grep -q "Ready=False" "$REASON_FILE" || fail "no readable reason: $(cat "$REASON_FILE")"
echo "    ok"

echo "All External Secrets checks passed."
