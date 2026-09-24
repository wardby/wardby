# Shell functions shared by up.sh and verify-eso-kind.sh, so the kind check
# exercises the same code the deployment runs. Both need KUBE_CONTEXT and
# NAMESPACE set. Source, do not execute.
#
# up.sh decides the order; these only do one step each. The order that keeps
# the live Secrets safe is: run_secrets_canary (proves a real read works),
# then release_unowned_secrets, then apply the real ExternalSecrets, then
# wait_external_secrets_synced.

# The ExternalSecret (and target Secret) name in secrets/canary.yaml.
SECRETS_CANARY="wardby-secrets-canary"

# Applies the canary ExternalSecret read from stdin, waits for it to sync, then
# deletes it (its Secret goes with it: ESO owns it). Returns 1, after printing
# the canary's conditions, if it does not sync within TIMEOUT.
#
# This is the proof that External Secrets can actually read Secret Manager --
# Workload Identity cannot be tested anywhere but the real cluster -- so up.sh
# runs it before anything deletes a live Secret.
run_secrets_canary() {
  local timeout="$1" rc=0
  kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" apply -f - >/dev/null
  wait_external_secrets_synced "$timeout" "$SECRETS_CANARY" || rc=1
  kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" delete externalsecret "$SECRETS_CANARY" \
    --ignore-not-found >/dev/null
  return "$rc"
}

# Deletes each named Secret that exists but is not owned by an ExternalSecret.
#
# The Secrets from before ESO were created by `kubectl apply`. up.sh calls this
# before it applies the real ExternalSecrets, so ESO creates each Secret fresh
# rather than adopting the old one (whose last-applied-configuration annotation
# still holds the old values). Running pods keep the environment they started
# with. Only call this after seed-secrets.mjs and run_secrets_canary have both
# succeeded, so every value is in Secret Manager and ESO can read it.
#
# If a matching ExternalSecret already exists (an interrupted earlier run), it
# may be sitting in ESO's error backoff from when the unowned Secret blocked it.
# Forcing a sync right after the delete makes ESO retry immediately instead of
# waiting out its backoff.
release_unowned_secrets() {
  local name owner
  for name in "$@"; do
    kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" get secret "$name" >/dev/null 2>&1 || continue
    owner="$(kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" get secret "$name" \
      -o jsonpath='{.metadata.ownerReferences[?(@.kind=="ExternalSecret")].name}')"
    if [[ -z "$owner" ]]; then
      echo "    handing ${name} over to External Secrets"
      kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" delete secret "$name" >/dev/null
      if kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" get externalsecret "$name" >/dev/null 2>&1; then
        kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" annotate externalsecret "$name" force-sync="$(date +%s)" --overwrite >/dev/null
      fi
    fi
  done
}

# Forces each named ExternalSecret to sync now and waits, up to TIMEOUT (e.g.
# 180s) for all of them together, until each has:
#   - a .status.refreshTime that is set and differs from the one it had before
#     the forced sync (so an old Ready=True from a previous sync never counts),
#   - Ready=True, and
#   - its target Secret present and owned by an ExternalSecret.
# On timeout prints the conditions of each one not yet synced -- never the
# Secret -- and returns 1.
wait_external_secrets_synced() {
  local timeout="${1%s}" name i
  shift
  local -a names=("$@") before=() done_=()
  local deadline=$(($(date +%s) + timeout))

  for i in "${!names[@]}"; do
    before[i]="$(kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" get externalsecret "${names[i]}" \
      -o jsonpath='{.status.refreshTime}' 2>/dev/null || true)"
    done_[i]=0
  done
  # refreshTime has one-second resolution. Waiting a second before the forced
  # sync guarantees the refresh it triggers carries a later time than the one
  # recorded, even if a sync had just finished within the same second.
  sleep 1
  for name in "${names[@]}"; do
    kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" annotate externalsecret "$name" \
      force-sync="$(date +%s)" --overwrite >/dev/null
  done

  local remaining refreshed ready target owner
  while :; do
    remaining=0
    for i in "${!names[@]}"; do
      [[ "${done_[i]}" == 1 ]] && continue
      name="${names[i]}"
      refreshed="$(kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" get externalsecret "$name" \
        -o jsonpath='{.status.refreshTime}' 2>/dev/null || true)"
      ready="$(kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" get externalsecret "$name" \
        -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || true)"
      target="$(kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" get externalsecret "$name" \
        -o jsonpath='{.spec.target.name}' 2>/dev/null || true)"
      owner="$(kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" get secret "${target:-$name}" \
        -o jsonpath='{.metadata.ownerReferences[?(@.kind=="ExternalSecret")].name}' 2>/dev/null || true)"
      if [[ -n "$refreshed" && "$refreshed" != "${before[i]}" && "$ready" == "True" && -n "$owner" ]]; then
        done_[i]=1
      else
        remaining=$((remaining + 1))
      fi
    done
    ((remaining == 0)) && return 0
    (($(date +%s) >= deadline)) && break
    sleep 2
  done

  for i in "${!names[@]}"; do
    [[ "${done_[i]}" == 1 ]] && continue
    echo "ExternalSecret ${names[i]} did not sync:" >&2
    kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" get externalsecret "${names[i]}" \
      -o jsonpath='{range .status.conditions[*]}  {.type}={.status} {.reason}: {.message}{"\n"}{end}' >&2 || true
  done
  return 1
}
