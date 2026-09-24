#!/usr/bin/env bash
#
# Proves the External Secrets setup on a throwaway kind cluster, using ESO's
# fake provider in place of Google Secret Manager (kind has no Workload
# Identity). Checks, against the committed manifests and values, following
# up.sh's step-7 order (SecretStore, canary, release_unowned_secrets, real
# ExternalSecrets, wait_external_secrets_synced):
#
#   1. A canary that cannot read its key fails wait_external_secrets_synced
#      within its timeout, and the pre-existing hand-made Secrets are still
#      there, untouched, afterwards: nothing is deleted before a read succeeds.
#   2. With a canary that can read, the hand-made Secrets (made by
#      `kubectl apply`, so carrying a last-applied-configuration annotation)
#      are handed over: each is recreated (new UID) and owned by its
#      ExternalSecret, the old annotation and a stale key are gone, and
#      AUTH_PROVIDER is merged in.
#   3. release_unowned_secrets' delete + force-sync branch for an
#      ExternalSecret that already exists (an interrupted earlier run) runs
#      and recovers: an ownerReferences strip forces the Secret back into the
#      unowned state.
#   4. ESO does nothing outside wardby-coding.
#   5. ESO's service account cannot write Secrets in another namespace.
#   6. wait_external_secrets_synced fails with a readable reason for a key
#      that does not exist.
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
# The namespace before helm, from the same file and in the same order as up.sh:
# the scoped chart creates its Role and RoleBinding in it.
k apply -f deploy/kind-coding/manifests/base/namespace.yaml >/dev/null
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

# canary.yaml with the prefix placeholder set to "test" and, optionally, its key
# swapped for one the store does not hold.
canary() {
  sed -e "s|wardby-secret-prefix-github-app-id|${1:-test-github-app-id}|" \
    -e 's|wardby-secret-prefix|test|g' "$SECRETS_DIR/canary.yaml"
}
decoded() { k -n "$NAMESPACE" get secret "$1" -o "jsonpath={.data.$2}" | base64 -d; }
uid_of() { k -n "$NAMESPACE" get secret "$1" -o jsonpath='{.metadata.uid}'; }
LAST_APPLIED='kubectl\.kubernetes\.io/last-applied-configuration'

# Hand-made Secrets as the pre-ESO setup left them: made by `kubectl apply`,
# so each carries a last-applied-configuration annotation holding its values.
fake_store "$NAMESPACE"
for name in wardby-coding-proxy-env wardby-control-plane-env; do
  printf 'apiVersion: v1\nkind: Secret\nmetadata:\n  name: %s\n  namespace: %s\nstringData:\n  STALE: "1"\n' \
    "$name" "$NAMESPACE" | k apply -f - >/dev/null
  [[ "$(k -n "$NAMESPACE" get secret "$name" -o "jsonpath={.metadata.annotations.${LAST_APPLIED}}")" == *STALE* ]] \
    || fail "setup: ${name} has no last-applied-configuration annotation holding its values"
done
OLD_PROXY_UID="$(uid_of wardby-coding-proxy-env)"
OLD_CP_UID="$(uid_of wardby-control-plane-env)"

echo "==> 1. a canary that cannot read leaves the live Secrets alone"
started="$(date +%s)"
if canary test-does-not-exist | run_secrets_canary 30s 2>"$REASON_FILE"; then
  fail "the canary synced a key that does not exist"
fi
elapsed=$(($(date +%s) - started))
((elapsed < 60)) || fail "the failing canary took ${elapsed}s, past its 30s timeout"
grep -q "Ready=False" "$REASON_FILE" || fail "no readable reason from the canary: $(cat "$REASON_FILE")"
if k -n "$NAMESPACE" get externalsecret "$SECRETS_CANARY" >/dev/null 2>&1; then
  fail "the failed canary ExternalSecret was not deleted"
fi
[[ "$(uid_of wardby-coding-proxy-env)" == "$OLD_PROXY_UID" ]] || fail "proxy Secret changed after a failed canary"
[[ "$(uid_of wardby-control-plane-env)" == "$OLD_CP_UID" ]] || fail "control-plane Secret changed after a failed canary"
[[ "$(decoded wardby-control-plane-env STALE)" == "1" ]] || fail "control-plane Secret lost its data after a failed canary"
echo "    ok"

echo "==> 2. up.sh's order hands over the pre-existing Secrets"
canary | run_secrets_canary 60s || fail "the canary did not sync"
if k -n "$NAMESPACE" get externalsecret "$SECRETS_CANARY" >/dev/null 2>&1; then
  fail "the canary ExternalSecret was not deleted after it synced"
fi
# The canary alone must not have touched the live Secrets either.
[[ "$(uid_of wardby-control-plane-env)" == "$OLD_CP_UID" ]] || fail "control-plane Secret changed before the handover"
release_unowned_secrets wardby-coding-proxy-env wardby-control-plane-env
real_external_secrets "$NAMESPACE" | k apply -f - >/dev/null
wait_external_secrets_synced 120s wardby-coding-proxy-env wardby-control-plane-env || fail "ExternalSecrets did not sync"
for name in wardby-coding-proxy-env wardby-control-plane-env; do
  k -n "$NAMESPACE" get secret "$name" -o jsonpath='{.metadata.ownerReferences[*].kind}' \
    | grep -q ExternalSecret || fail "${name} is not owned by an ExternalSecret"
  # ESO copies the ExternalSecret's own annotations onto the Secret, so a
  # last-applied-configuration may be there -- but it must be the
  # ExternalSecret's (key names only), never the old Secret's (its values).
  applied="$(k -n "$NAMESPACE" get secret "$name" -o "jsonpath={.metadata.annotations.${LAST_APPLIED}}")"
  if [[ "$applied" == *'"kind":"Secret"'* || "$applied" == *STALE* ]]; then
    fail "${name} kept the old Secret's last-applied-configuration annotation"
  fi
  [[ -z "$(decoded "$name" STALE)" ]] || fail "stale key survived the handover in ${name}"
done
[[ "$(uid_of wardby-coding-proxy-env)" != "$OLD_PROXY_UID" ]] || fail "proxy Secret was not recreated (UID unchanged)"
[[ "$(uid_of wardby-control-plane-env)" != "$OLD_CP_UID" ]] || fail "control-plane Secret was not recreated (UID unchanged)"
[[ "$(decoded wardby-control-plane-env AUTH_PROVIDER)" == "self-hosted" ]] || fail "AUTH_PROVIDER not merged"
[[ "$(decoded wardby-control-plane-env SECRET_APP_KEY)" == "dummy-secret-app-key" ]] || fail "SECRET_APP_KEY not synced"
[[ "$(decoded wardby-coding-proxy-env DATABASE_URL)" == "dummy-database-url" ]] || fail "DATABASE_URL not synced"
echo "    ok"

echo "==> 3. release_unowned_secrets' delete + force-sync branch actually runs"
# In check 2 the ExternalSecrets did not exist yet when release_unowned_secrets
# ran. After an interrupted earlier run they may: force the Secret back into
# the unowned state with its ExternalSecret already present, then prove the
# branch runs and recovers: the Secret must be deleted and recreated (new
# UID), re-owned by the ExternalSecret, and carry the same synced values.
OLD_UID="$(uid_of wardby-control-plane-env)"
k -n "$NAMESPACE" patch secret wardby-control-plane-env --type=json \
  -p '[{"op":"remove","path":"/metadata/ownerReferences"}]' >/dev/null
release_unowned_secrets wardby-control-plane-env
wait_external_secrets_synced 120s wardby-control-plane-env || fail "ExternalSecret not synced after re-release"
NEW_UID="$(uid_of wardby-control-plane-env)"
[[ "$NEW_UID" != "$OLD_UID" ]] || fail "release_unowned_secrets did not delete+recreate the Secret (UID unchanged)"
k -n "$NAMESPACE" get secret wardby-control-plane-env -o jsonpath='{.metadata.ownerReferences[*].kind}' \
  | grep -q ExternalSecret || fail "Secret has no ExternalSecret owner after re-release"
[[ "$(decoded wardby-control-plane-env AUTH_PROVIDER)" == "self-hosted" ]] || fail "AUTH_PROVIDER not merged after re-release"
[[ "$(decoded wardby-control-plane-env SECRET_APP_KEY)" == "dummy-secret-app-key" ]] || fail "SECRET_APP_KEY not synced after re-release"
echo "    ok"

echo "==> 4. nothing syncs outside wardby-coding"
fake_store other
real_external_secrets other | k apply -f - >/dev/null
sleep 20
if k -n other get secret wardby-control-plane-env >/dev/null 2>&1; then fail "ESO wrote a Secret in namespace other"; fi
echo "    ok"

echo "==> 5. ESO cannot write Secrets elsewhere"
ESO_SA_NAME="$(k -n external-secrets get deploy external-secrets -o jsonpath='{.spec.template.spec.serviceAccountName}')"
ESO_SA="system:serviceaccount:external-secrets:${ESO_SA_NAME}"
[[ "$(k auth can-i create secrets -n other --as "$ESO_SA")" == "no" ]] || fail "ESO can create Secrets in other"
[[ "$(k auth can-i create secrets -n "$NAMESPACE" --as "$ESO_SA")" == "yes" ]] || fail "ESO cannot create Secrets in wardby-coding"
echo "    ok"

echo "==> 6. a missing key fails the wait with a reason"
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
if wait_external_secrets_synced 30s missing-key-check 2>"$REASON_FILE"; then fail "wait succeeded for a missing key"; fi
grep -q "Ready=False" "$REASON_FILE" || fail "no readable reason: $(cat "$REASON_FILE")"
echo "    ok"

echo "All External Secrets checks passed."
