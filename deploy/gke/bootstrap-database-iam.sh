#!/usr/bin/env bash
#
# One-time setup for password-less database access, and the emergency admin
# login afterwards. Applies deploy/gke/database-grants.sql as the built-in
# owner from inside the cluster (the instance has no public address).
#
#   deploy/gke/bootstrap-database-iam.sh                        # default
#   <current password> | deploy/gke/bootstrap-database-iam.sh --password-from-stdin
#   deploy/gke/bootstrap-database-iam.sh --force-rotate         # emergency only
#   ... --check                                                  # dry run, any mode
#
# Default -- the path for a new deployment, and for reapplying grants on an
# existing one (e.g. once the coding proxy's ledger table exists): sets a
# random owner password through the Cloud SQL Admin API (creating the owner if
# it does not exist), uses it once, then resets it to another random value
# that is never stored. The reset runs on every exit, including a failed
# grant. --password-from-stdin: uses the given current password and leaves it
# unchanged -- for moving an older deployment, whose pods still hold a
# password DATABASE_URL, to IAM login.
#
# Default mode refuses while the Secret wardby-control-plane-env still has a
# DATABASE_URL key: that means an older, not-yet-migrated deployment whose
# pods still log in with the owner password, and changing it would cut them
# off. Use --password-from-stdin to move that deployment to IAM login instead.
# --force-rotate (default mode only) overrides that check -- an emergency
# measure that cuts off any pod still using the password.
#
# The grants run in one transaction: a statement the database refuses leaves
# nothing applied. --check runs them in a transaction that is then rolled back,
# and reports success or the exact refusal while changing no grant. It needs a
# password like any run: combine it with --password-from-stdin (the live path),
# or in default mode it obeys the same refusal as a real run. On a live
# deployment, run --check first, then the real run.
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
CHECK=false
for arg in "$@"; do
  case "$arg" in
    --password-from-stdin) FROM_STDIN=true ;;
    --force-rotate) FORCE_ROTATE=true ;;
    --check) CHECK=true ;;
    *) echo "usage: $0 [--password-from-stdin | --force-rotate] [--check]" >&2; exit 2 ;;
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
# Every call is bounded, so an unresponsive API server cannot hang the script
# (or its cleanup, which ignores signals) indefinitely.
k() { kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" --request-timeout=30s "$@"; }

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
still has a DATABASE_URL, so this is an older deployment whose running pods
still log in with this password. Use --password-from-stdin with the current
password to move it to IAM login. Pass --force-rotate only in an emergency,
knowing it cuts off any pod still using the password.
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

# The Job runs the grants file in one transaction. --check points psql at a
# wrapper that runs the same file inside BEGIN ... ROLLBACK instead, without
# --single-transaction (which would wrap the wrapper's own BEGIN). Refuses
# output that is not exactly the mode asked for.
CHECK_SQL=$'BEGIN;\n\\i /grants/database-grants.sql\nROLLBACK;\n'
select_mode() {
  local rendered
  if $CHECK; then
    rendered="$(sed -E \
      -e '/^[[:space:]]*- --single-transaction$/d' \
      -e 's#^([[:space:]]*- )/grants/database-grants\.sql$#\1/grants/check.sql#')"
    if grep -Eq '^[[:space:]]*- (--single-transaction|/grants/database-grants\.sql)$' <<<"$rendered" ||
      ! grep -Eq '^[[:space:]]*- /grants/check\.sql$' <<<"$rendered"; then
      echo "bootstrap: could not switch the grants Job to --check." >&2
      return 1
    fi
  else
    rendered="$(cat)"
    if ! grep -Eq '^[[:space:]]*- --single-transaction$' <<<"$rendered"; then
      echo "bootstrap: the grants Job does not run in a single transaction." >&2
      return 1
    fi
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
  # A second signal must not cut cleanup short: it resets the password and
  # deletes the Secret.
  trap '' INT TERM HUP
  set +e
  # The reset first: if the cluster calls below stall, all they leave behind is
  # a Secret holding a password that no longer works.
  if $PASSWORD_SET; then
    if set_owner_password "$(openssl rand -hex 24)"; then
      echo "==> reset ${OWNER} to a password nobody holds"
    else
      echo "bootstrap: WARNING: resetting the ${OWNER} password failed; the one-time password may still be valid. Re-run this script to reset it." >&2
      rc=1
    fi
  fi
  if ! k delete secret wardby-database-bootstrap --ignore-not-found >/dev/null 2>&1; then
    echo "bootstrap: WARNING: deleting Secret ${NAMESPACE}/wardby-database-bootstrap failed; it may still hold the ${OWNER} password (the live one, with --password-from-stdin). Delete it: kubectl -n ${NAMESPACE} delete secret wardby-database-bootstrap" >&2
  fi
  k delete job "$JOB" --ignore-not-found >/dev/null 2>&1
  k delete configmap wardby-database-grants --ignore-not-found >/dev/null 2>&1
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
# check.sql is used only by --check; it holds no value, only the wrapper.
render_grants | k create configmap wardby-database-grants --from-file=database-grants.sql=/dev/stdin \
  --from-literal=check.sql="$CHECK_SQL" --dry-run=client -o yaml | k apply -f - >/dev/null

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

render <deploy/gke/bootstrap-grants-job.yaml | select_mode | k apply -f - >/dev/null

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
  if $CHECK; then
    echo "bootstrap: --check: the grants would NOT apply (${state:-timed out}); nothing was changed. The refusal is in the psql log below." >&2
  else
    echo "bootstrap: the grants Job did not complete (${state:-timed out}). The grants run in one transaction, so a refused statement applied none of them." >&2
  fi
  echo "--- psql" >&2
  k logs "job/${JOB}" -c psql --tail=50 >&2 || true
  echo "--- cloud-sql-proxy (a Workload Identity or IAM problem shows here)" >&2
  k logs "job/${JOB}" -c cloud-sql-proxy --tail=50 >&2 || true
  exit 1
fi
if $CHECK; then
  echo "==> --check: every grant applies; rolled back, nothing was changed"
else
  echo "==> grants applied"
fi
