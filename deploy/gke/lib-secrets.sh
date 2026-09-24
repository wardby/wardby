# Shell functions shared by up.sh and verify-eso-kind.sh, so the kind check
# exercises the same code the deployment runs. Both need KUBE_CONTEXT and
# NAMESPACE set. Source, do not execute.

# Deletes each named Secret that exists but is not owned by an ExternalSecret.
#
# The Secrets from before ESO were created by `kubectl apply`. ESO recreates a
# deleted one from Secret Manager within seconds; running pods keep the
# environment they started with. Only call this after seed-secrets.mjs has
# succeeded, so every value is already in Secret Manager.
#
# If a matching ExternalSecret already exists, it may be sitting in ESO's error
# backoff from when the unowned Secret blocked it, so ESO might not notice the
# deletion and recreate the Secret before wait_external_secrets_ready's timeout.
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

# Waits for each named ExternalSecret to report Ready=True. On timeout, prints
# the ExternalSecret's status conditions -- never the Secret -- and returns 1.
wait_external_secrets_ready() {
  local timeout="$1" name
  shift
  for name in "$@"; do
    if ! kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" wait "externalsecret/${name}" \
      --for=condition=Ready --timeout="$timeout" >/dev/null 2>&1; then
      echo "ExternalSecret ${name} is not Ready:" >&2
      kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" get externalsecret "$name" \
        -o jsonpath='{range .status.conditions[*]}  {.type}={.status} {.reason}: {.message}{"\n"}{end}' >&2 || true
      return 1
    fi
  done
}
