#!/usr/bin/env bash
#
# One-time setup for password-less database access, and the emergency admin
# login afterwards. Applies deploy/gke/database-grants.sql as the built-in
# owner from inside the cluster (the instance has no public address).
#
#   deploy/gke/bootstrap-database-iam.sh                        # default
#   <current password> | deploy/gke/bootstrap-database-iam.sh --password-from-stdin
#   deploy/gke/bootstrap-database-iam.sh --force-rotate         # emergency only
#
# Default: sets a random owner password through the Cloud SQL Admin API (creating
# the owner if it does not exist), uses it once, then resets it to another random
# value that is never stored. The reset runs on every exit, including a failed
# grant. --password-from-stdin: uses the given current password and leaves it
# unchanged -- for moving a running deployment, whose pods still use it, to IAM
# login.
#
# Default mode refuses while the Secret wardby-control-plane-env still has a
# DATABASE_URL key: the running pods still log in with the owner password, and
# changing it would cut them off. Use --password-from-stdin then, or finish
# retiring the password first. --force-rotate (default mode only) overrides
# that check -- an emergency measure that cuts off any pod still using the
# password.
#
# No password or token is ever a process argument, printed, or written to a
# file. The password reaches the cluster only as a Secret that exists for the
# length of the run.
#
# KUBE_CONTEXT overrides the kubectl context (default: the one
# `gcloud container clusters get-credentials` creates for the Terraform cluster).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

for tool in terraform gcloud kubectl curl openssl base64; do
  command -v "$tool" >/dev/null || { echo "bootstrap: ${tool} is required." >&2; exit 1; }
done

TF_DIR="deploy/gke"
MIGRATE_DIR="deploy/kind-coding/manifests/overlays/gke-autopilot/migrate"
NAMESPACE="wardby-coding"
JOB="wardby-database-grants"
out() { terraform -chdir="$TF_DIR" output -raw "$1"; }

FROM_STDIN=false
FORCE_ROTATE=false
for arg in "$@"; do
  case "$arg" in
    --password-from-stdin) FROM_STDIN=true ;;
    --force-rotate) FORCE_ROTATE=true ;;
    *) echo "usage: $0 [--password-from-stdin | --force-rotate]" >&2; exit 2 ;;
  esac
done
if $FROM_STDIN && $FORCE_ROTATE; then
  echo "bootstrap: --force-rotate applies only to the default mode; --password-from-stdin never changes the password." >&2
  exit 2
fi

PROJECT_ID="$(out project_id)"
REGION="$(out region)"
CLUSTER="$(out cluster_name)"
INSTANCE="$(out instance_name)"
CONNECTION="$(out instance_connection_name)"
DB_NAME="$(out database_name)"
OWNER="$(out database_user)"
DB_IP="$(out private_ip_address)"
MIGRATOR_GSA="$(out migrator_service_account)"
MIGRATOR_USER="$(out migrator_database_user)"
APP_USER="$(out app_database_user)"
PROXY_USER="$(out proxy_database_user)"
KUBE_CONTEXT="${KUBE_CONTEXT:-gke_${PROJECT_ID}_${REGION}_${CLUSTER}}"
k() { kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" "$@"; }

# Read first, so nothing else on stdin can be mistaken for it.
PASSWORD=""
if $FROM_STDIN; then
  if [[ -t 0 ]]; then
    IFS= read -rs -p "Current ${OWNER} password: " PASSWORD || true
    echo >&2
  else
    IFS= read -r PASSWORD || true
  fi
  [[ -n "$PASSWORD" ]] || { echo "bootstrap: no password on stdin." >&2; exit 1; }
fi

# Default mode changes the owner password. Refuse while the running pods still
# log in with it. Only whether the DATABASE_URL key exists is read (its length
# via wc -c), never its value. A missing Secret (fresh deployment) passes; any
# other kubectl error stops the script.
if ! $FROM_STDIN && ! $FORCE_ROTATE; then
  url_bytes="$(k get secret wardby-control-plane-env --ignore-not-found -o jsonpath='{.data.DATABASE_URL}' | wc -c)"
  if ((url_bytes > 0)); then
    cat >&2 <<EOF
bootstrap: refusing to change the ${OWNER} password: Secret wardby-control-plane-env
still has a DATABASE_URL, so the running pods still log in with this password.
Use --password-from-stdin with the current password, or finish retiring the
password first. Pass --force-rotate only in an emergency, knowing it cuts off
any pod still using the password.
EOF
    exit 1
  fi
fi

# --- placeholders ------------------------------------------------------------

# Escapes a value for the replacement side of a `s#...#...#` expression.
sed_escape() { printf '%s' "$1" | sed -e 's/[\\&#]/\\&/g'; }

# Substitutes a placeholder only where it is a whole value: after whitespace and
# ending the line. `wardby-migrator` and `wardby-migrate` are real resource names
# that prefix placeholders, so a bare-prefix match is never used. Refuses output
# that still holds a placeholder.
render() {
  local rendered
  rendered="$(sed -E \
    -e "s#([[:space:]])wardby-instance-connection-name\$#\1$(sed_escape "$CONNECTION")#" \
    -e "s#([[:space:]])wardby-migrator-gsa-email\$#\1$(sed_escape "$MIGRATOR_GSA")#" \
    -e "s#([[:space:]])wardby-database-name\$#\1$(sed_escape "$DB_NAME")#" \
    -e "s#([[:space:]])wardby-owner-user\$#\1$(sed_escape "$OWNER")#" \
    -e "s#(cidr:[[:space:]]+)wardby-database-cidr\$#\1$(sed_escape "$DB_IP")/32#")"
  if grep -Eq '[[:space:]]wardby-(instance-connection-name|migrator-gsa-email|database-name|owner-user|database-cidr)$' <<<"$rendered"; then
    echo "bootstrap: a placeholder was left unsubstituted." >&2
    return 1
  fi
  printf '%s\n' "$rendered"
}

render_grants() {
  local rendered
  rendered="$(sed \
    -e "s#{{owner}}#$(sed_escape "$OWNER")#g" \
    -e "s#{{migrator}}#$(sed_escape "$MIGRATOR_USER")#g" \
    -e "s#{{app}}#$(sed_escape "$APP_USER")#g" \
    -e "s#{{proxy}}#$(sed_escape "$PROXY_USER")#g" \
    deploy/gke/database-grants.sql)"
  if grep -q '{{' <<<"$rendered"; then
    echo "bootstrap: a placeholder was left in database-grants.sql." >&2
    return 1
  fi
  printf '%s\n' "$rendered"
}

# --- Cloud SQL Admin API -----------------------------------------------------

# Calls the Admin API. The request body comes on stdin (curl --data-binary @-)
# and the token through a process-substitution header file, so neither is ever
# argv. Prints the response body, then a last line holding the HTTP status (000
# if the request never completed). Callers print only that status, never the
# body.
sqladmin() {
  local method="$1" path="$2" token
  token="$(gcloud auth print-access-token)" || return 1
  local url="https://sqladmin.googleapis.com/v1/projects/${PROJECT_ID}/${path}"
  if [[ "$method" == GET ]]; then
    curl -sS --max-time 60 -w '\n%{http_code}' "$url" \
      -H @<(printf 'Authorization: Bearer %s\n' "$token") || true
  else
    curl -sS --max-time 60 -w '\n%{http_code}' -X "$method" "$url" \
      -H @<(printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$token") \
      --data-binary @- || true
  fi
}

# User changes are asynchronous: the new password is only good once the
# operation the call returned is DONE.
wait_for_operation() {
  local operation="$1" response deadline=$((SECONDS + 120))
  [[ -n "$operation" ]] || { echo "bootstrap: the Admin API returned no operation to wait for." >&2; return 1; }
  while ((SECONDS < deadline)); do
    response="$(sqladmin GET "operations/${operation}" </dev/null)" || return 1
    [[ "${response##*$'\n'}" == 2?? ]] || { echo "bootstrap: reading operation ${operation} failed (HTTP ${response##*$'\n'})." >&2; return 1; }
    if grep -Eq '"status": *"DONE"' <<<"$response"; then
      grep -q '"error"' <<<"$response" && { echo "bootstrap: operation ${operation} failed." >&2; return 1; }
      return 0
    fi
    sleep 2
  done
  echo "bootstrap: operation ${operation} did not finish in 120s." >&2
  return 1
}

# Sets the owner's password, creating the owner if it does not exist.
set_owner_password() {
  local password="$1" response status operation
  [[ -n "$password" ]] || { echo "bootstrap: refusing to set an empty password." >&2; return 1; }
  response="$(printf '{"name":"%s","password":"%s"}' "$OWNER" "$password" |
    sqladmin PUT "instances/${INSTANCE}/users?name=${OWNER}")" || return 1
  status="${response##*$'\n'}"
  if [[ "$status" == 404 ]]; then
    response="$(printf '{"name":"%s","password":"%s"}' "$OWNER" "$password" |
      sqladmin POST "instances/${INSTANCE}/users")" || return 1
    status="${response##*$'\n'}"
  fi
  [[ "$status" == 2?? ]] || { echo "bootstrap: setting the ${OWNER} password failed (HTTP ${status})." >&2; return 1; }
  operation="$(sed -n 's/^[[:space:]]*"name":[[:space:]]*"\([^"]*\)".*/\1/p' <<<"${response%$'\n'*}" | head -n 1)"
  wait_for_operation "$operation"
}

# --- cleanup, on every exit --------------------------------------------------

PASSWORD_SET=false
cleanup() {
  local rc=$?
  # A second signal must not cut cleanup short: it deletes the Secret and resets
  # the password.
  trap '' INT TERM HUP
  set +e
  k delete secret wardby-database-bootstrap --ignore-not-found >/dev/null 2>&1
  k delete job "$JOB" --ignore-not-found >/dev/null 2>&1
  k delete configmap wardby-database-grants --ignore-not-found >/dev/null 2>&1
  if $PASSWORD_SET; then
    if set_owner_password "$(openssl rand -hex 24)"; then
      echo "==> reset ${OWNER} to a password nobody holds"
    else
      echo "bootstrap: WARNING: resetting the ${OWNER} password failed; the one-time password may still be valid. Re-run this script to reset it." >&2
      rc=1
    fi
  fi
  PASSWORD=""
  unset PASSWORD
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

# --- run ---------------------------------------------------------------------

echo "==> migrator identity and its network rules"
k apply -f deploy/kind-coding/manifests/base/namespace.yaml >/dev/null 2>&1 || true
render <"$MIGRATE_DIR/migrator.yaml" | k apply -f - >/dev/null

echo "==> grants"
k delete job "$JOB" --ignore-not-found >/dev/null
render_grants | k create configmap wardby-database-grants --from-file=database-grants.sql=/dev/stdin \
  --dry-run=client -o yaml | k apply -f - >/dev/null

if ! $FROM_STDIN; then
  PASSWORD="$(openssl rand -hex 24)"
  # Set before the call: a request that fails after the server applied it
  # must still be reset.
  PASSWORD_SET=true
  set_owner_password "$PASSWORD"
  echo "==> set a one-time password for ${OWNER}"
fi

# `create`, not `apply`: apply would copy the data into a
# last-applied-configuration annotation.
k delete secret wardby-database-bootstrap --ignore-not-found >/dev/null
{
  printf 'apiVersion: v1\nkind: Secret\ntype: Opaque\nmetadata:\n  name: wardby-database-bootstrap\n  namespace: %s\ndata:\n' "$NAMESPACE"
  printf '  password: %s\n' "$(printf '%s' "$PASSWORD" | base64 | tr -d '\n')"
} | k create -f - >/dev/null

render <deploy/gke/bootstrap-grants-job.yaml | k apply -f - >/dev/null

# The Job's activeDeadlineSeconds is 600; wait a little longer for it to be
# marked Failed, and never forever.
state=""
deadline=$((SECONDS + 660))
while ((SECONDS < deadline)); do
  state="$(k get job "$JOB" -o jsonpath='{.status.conditions[?(@.status=="True")].type}' 2>/dev/null || true)"
  case " $state " in
    *" Complete "* | *" Failed "*) break ;;
  esac
  sleep 5
done
if [[ " $state " != *" Complete "* ]]; then
  echo "bootstrap: the grants Job did not complete (${state:-timed out})." >&2
  echo "--- psql" >&2
  k logs "job/${JOB}" -c psql --tail=50 >&2 || true
  echo "--- cloud-sql-proxy (a Workload Identity or IAM problem shows here)" >&2
  k logs "job/${JOB}" -c cloud-sql-proxy --tail=50 >&2 || true
  exit 1
fi
echo "==> grants applied"
