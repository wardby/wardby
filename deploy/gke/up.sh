#!/usr/bin/env bash
#
# Stands up a wardby control plane on GKE Autopilot, from Terraform through to a
# serving MCP endpoint.
#
#   WARDBY_HOSTNAME=app.example.com deploy/gke/up.sh
#   WARDBY_LOW_POWER=1 WARDBY_HOSTNAME=app.example.com deploy/gke/up.sh   # low-power mode
#   WARDBY_GITHUB_ALLOWED_ACCOUNTS=acme,acme-labs   # optional: accounts the GitHub App serves besides its owner
#   WARDBY_MOBILE_ENABLED=true   # optional: allow the wardby mobile app to sign in (default false)
#   WARDBY_MENTION_EXPLANATIONS=false   # optional: no reply saying why a mention started nothing (default true)
#   WARDBY_DEPENDENCY_CACHE=true   # optional: run dependency cache on the coding proxy (default false; needs dependency_cache_enabled in terraform.tfvars)
#   WARDBY_SESSION_TRANSCRIPTS=true   # optional: store sessionResume transcripts on the control plane (default false; needs session_transcripts_enabled in terraform.tfvars)
#   RUN_TRANSCRIPT_MAX_BYTES=20971520   # optional: largest transcript stored, with WARDBY_SESSION_TRANSCRIPTS=true (default 10 MiB)
#   CODING_MAX_DISK_MB=8192   # optional: largest per-agent workspaceDiskMb the control plane accepts (default 2048)
#   CODING_MEMORY_MB=6144   # optional: memory for each coding run's pod, in MiB (default 2048)
#   CODING_CPUS=2   # optional: CPUs for each coding run's pod (default 1)
#
# Idempotent: safe to re-run. Terraform converges, images are rebuilt and
# re-pushed (digests change only if the source did), values already in Secret
# Manager are left as they are and only empty secrets are seeded, and the
# overlay is re-applied.
#
# This exists because the first GKE cluster was built interactively over several
# hours, with corrections applied as things broke. That found eight
# environment-specific defects, but it left the procedure living in one person's
# session rather than in the repository. Everything below is what was actually
# done, in the order it has to happen.
#
# NOT the long-term shape. A shell script has no drift detection and no dry run,
# and the substitution list below is already straining. The declarative
# successors are kustomize's own `images:`/`replacements:` fed by Terraform
# outputs, or a Helm chart once people install wardby rather than read it. This
# script is how that knowledge got out of a scratchpad; treat it as a floor.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

source deploy/gke/eso.env
source deploy/gke/lib-secrets.sh

# curl, openssl and base64 are for step 9 (bootstrap-database-iam.sh), checked here
# so a missing one stops the deploy before anything changes rather than after the
# migrations.
for tool in terraform gcloud kubectl docker helm node curl openssl base64; do
  command -v "$tool" >/dev/null || { echo "up.sh: ${tool} is required." >&2; exit 1; }
done

TF_DIR="deploy/gke"
# low-power mode selection
# WARDBY_LOW_POWER=1 applies the gke-autopilot-low-power overlay (the control plane
# scales the coding proxy and native gateway to zero when idle); unset or 0 applies
# the plain gke-autopilot overlay and removes anything an earlier low-power run left.
LOW_POWER="${WARDBY_LOW_POWER:-0}"
case "$LOW_POWER" in 0|1) ;; *) echo "up.sh: WARDBY_LOW_POWER must be 0 or 1" >&2; exit 1 ;; esac
OVERLAY_DIR_NAME=gke-autopilot
LOW_POWER_LABEL=off
if [ "$LOW_POWER" = 1 ]; then
  OVERLAY_DIR_NAME=gke-autopilot-low-power
  LOW_POWER_LABEL=on
fi
OVERLAY="deploy/kind-coding/manifests/overlays/${OVERLAY_DIR_NAME}"
# end low-power mode selection
NAMESPACE="wardby-coding"
TOTAL_STEPS=13

# Not HOSTNAME: bash and zsh set that to the machine's own name, so a required-variable check on
# it always passes and the machine name ends up in the Gateway, routes and auth audience.
: "${WARDBY_HOSTNAME:?set WARDBY_HOSTNAME to the hostname the MCP endpoint is published on (e.g. app.example.com)}"
if ! [[ "$WARDBY_HOSTNAME" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$ ]]; then
  echo "up.sh: WARDBY_HOSTNAME must be a lowercase DNS name with at least one dot, no scheme or path (got \"$WARDBY_HOSTNAME\")." >&2
  exit 1
fi
case "$WARDBY_HOSTNAME" in
  *.lan | *.local | *.localdomain | *.internal | localhost | localhost.*)
    echo "up.sh: WARDBY_HOSTNAME \"$WARDBY_HOSTNAME\" is a local name, not a public hostname." >&2
    exit 1
    ;;
esac

# --- WARDBY_GITHUB_ALLOWED_ACCOUNTS check ---
# Optional: GitHub accounts the App serves in addition to its owner
# (comma-separated logins). Empty = the App's owner only. Substituted in step 10.
WARDBY_GITHUB_ALLOWED_ACCOUNTS="${WARDBY_GITHUB_ALLOWED_ACCOUNTS:-}"
if [[ -n "$WARDBY_GITHUB_ALLOWED_ACCOUNTS" ]] &&
  ! [[ "$WARDBY_GITHUB_ALLOWED_ACCOUNTS" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}(,[A-Za-z0-9][A-Za-z0-9-]{0,38})*$ ]]; then
  echo "up.sh: WARDBY_GITHUB_ALLOWED_ACCOUNTS must be comma-separated GitHub logins with no spaces (got \"$WARDBY_GITHUB_ALLOWED_ACCOUNTS\")." >&2
  exit 1
fi
echo "up.sh: the GitHub App will serve its owner${WARDBY_GITHUB_ALLOWED_ACCOUNTS:+ plus ${WARDBY_GITHUB_ALLOWED_ACCOUNTS}}."
# --- end WARDBY_GITHUB_ALLOWED_ACCOUNTS check ---

# --- WARDBY_MOBILE_ENABLED check ---
# Optional: true lets the wardby mobile app sign in. Empty = false. Substituted
# in step 10; the overlay placeholder is neither true nor false, so the server
# refuses to start if it is ever left unsubstituted.
WARDBY_MOBILE_ENABLED="${WARDBY_MOBILE_ENABLED:-false}"
case "$WARDBY_MOBILE_ENABLED" in
  true | false) ;;
  *)
    echo "up.sh: WARDBY_MOBILE_ENABLED must be true or false (got \"$WARDBY_MOBILE_ENABLED\")." >&2
    exit 1
    ;;
esac
if [[ "$WARDBY_MOBILE_ENABLED" = true ]]; then
  echo "up.sh: mobile sign-in is on."
else
  echo "up.sh: mobile sign-in is off."
fi
# --- end WARDBY_MOBILE_ENABLED check ---

# --- WARDBY_MENTION_EXPLANATIONS check ---
# Optional: false stops the GitHub App replying to say why a mention started
# nothing (the reply is a comment anyone who can see the repository reads).
# Empty = true, the server's default.
WARDBY_MENTION_EXPLANATIONS="${WARDBY_MENTION_EXPLANATIONS:-true}"
case "$WARDBY_MENTION_EXPLANATIONS" in
  true | false) ;;
  *)
    echo "up.sh: WARDBY_MENTION_EXPLANATIONS must be true or false (got \"$WARDBY_MENTION_EXPLANATIONS\")." >&2
    exit 1
    ;;
esac
if [[ "$WARDBY_MENTION_EXPLANATIONS" = false ]]; then
  echo "up.sh: mentions that start nothing get no explanation."
fi
# --- end WARDBY_MENTION_EXPLANATIONS check ---

# --- WARDBY_MENTION_EXPLANATIONS control-plane env ---
# Adds WARDBY_MENTION_EXPLANATIONS to the control plane's container, right
# after its WARDBY_MOBILE_ENABLED entry, like CODING_MAX_DISK_MB below. Only
# when false: true is the server's default. The control plane receives the
# GitHub webhooks, so it is the only container that reads it.
inject_mention_explanations_env() {
  if [[ "$WARDBY_MENTION_EXPLANATIONS" != false ]]; then
    cat
    return
  fi
  awk '
    { print }
    /^ *value: wardby_mobile_enabled$/ {
      match($0, /^ */); value_indent = substr($0, 1, RLENGTH); item_indent = substr(value_indent, 3)
      print item_indent "- name: WARDBY_MENTION_EXPLANATIONS"; print value_indent "value: \"false\""
    }'
}
# --- end WARDBY_MENTION_EXPLANATIONS control-plane env ---

# --- CODING_MAX_DISK_MB check ---
# Optional: the largest workspace (MiB) an agent's workspaceDiskMb may ask for.
# Empty = the server default (CODING_DISK_MB, 2048). The server itself refuses a
# value over the platform's ephemeral-storage ceiling at startup.
CODING_MAX_DISK_MB="${CODING_MAX_DISK_MB:-}"
if [[ -n "$CODING_MAX_DISK_MB" ]]; then
  if ! [[ "$CODING_MAX_DISK_MB" =~ ^[1-9][0-9]{1,4}$ ]] || ((CODING_MAX_DISK_MB < 2048 || CODING_MAX_DISK_MB > 32768)); then
    echo "up.sh: CODING_MAX_DISK_MB must be an integer between 2048 and 32768 (got \"$CODING_MAX_DISK_MB\")." >&2
    exit 1
  fi
  echo "up.sh: coding workspaces may be up to ${CODING_MAX_DISK_MB} MiB."
fi
# --- end CODING_MAX_DISK_MB check ---

# --- CODING_MAX_DISK_MB control-plane env ---
# Adds CODING_MAX_DISK_MB to the control plane's container, right after its
# WARDBY_MOBILE_ENABLED entry (the one place that placeholder appears), in the
# same indentation. Does nothing when unset. The control plane launches coding
# runs, so it is the only container that reads it.
inject_coding_max_disk_env() {
  if [[ -z "$CODING_MAX_DISK_MB" ]]; then
    cat
    return
  fi
  awk -v mib="$CODING_MAX_DISK_MB" '
    { print }
    /^ *value: wardby_mobile_enabled$/ {
      match($0, /^ */); value_indent = substr($0, 1, RLENGTH); item_indent = substr(value_indent, 3)
      print item_indent "- name: CODING_MAX_DISK_MB"; print value_indent "value: \"" mib "\""
    }'
}
# --- end CODING_MAX_DISK_MB control-plane env ---

# --- CODING_MEMORY_MB and CODING_CPUS check ---
# Optional: the memory (MiB) and CPUs of every coding run's pod. Empty = the
# server defaults (2048 MiB, 1 CPU). On Autopilot the server fits them to the
# platform's memory:CPU band when it builds each pod.
CODING_MEMORY_MB="${CODING_MEMORY_MB:-}"
CODING_CPUS="${CODING_CPUS:-}"
if [[ -n "$CODING_MEMORY_MB" ]]; then
  if ! [[ "$CODING_MEMORY_MB" =~ ^[1-9][0-9]{3,4}$ ]] || ((CODING_MEMORY_MB < 1024 || CODING_MEMORY_MB > 32768)); then
    echo "up.sh: CODING_MEMORY_MB must be an integer between 1024 and 32768 (got \"$CODING_MEMORY_MB\")." >&2
    exit 1
  fi
  echo "up.sh: coding pods get ${CODING_MEMORY_MB} MiB of memory."
fi
if [[ -n "$CODING_CPUS" ]]; then
  if ! [[ "$CODING_CPUS" =~ ^[0-9]{1,2}(\.[0-9]{1,3})?$ ]] || ! awk -v c="$CODING_CPUS" 'BEGIN { exit !(c >= 0.25 && c <= 16) }'; then
    echo "up.sh: CODING_CPUS must be a number between 0.25 and 16 (got \"$CODING_CPUS\")." >&2
    exit 1
  fi
  echo "up.sh: coding pods get ${CODING_CPUS} CPUs."
fi
# --- end CODING_MEMORY_MB and CODING_CPUS check ---

# --- CODING_MEMORY_MB and CODING_CPUS control-plane env ---
# Adds whichever of the two is set to the control plane's container, right after
# its WARDBY_MOBILE_ENABLED entry, like CODING_MAX_DISK_MB above. The control
# plane builds the coding pods, so it is the only container that reads them.
inject_coding_resources_env() {
  if [[ -z "$CODING_MEMORY_MB" && -z "$CODING_CPUS" ]]; then
    cat
    return
  fi
  awk -v mib="$CODING_MEMORY_MB" -v cpus="$CODING_CPUS" '
    { print }
    /^ *value: wardby_mobile_enabled$/ {
      match($0, /^ */); value_indent = substr($0, 1, RLENGTH); item_indent = substr(value_indent, 3)
      if (mib != "") { print item_indent "- name: CODING_MEMORY_MB"; print value_indent "value: \"" mib "\"" }
      if (cpus != "") { print item_indent "- name: CODING_CPUS"; print value_indent "value: \"" cpus "\"" }
    }'
}
# --- end CODING_MEMORY_MB and CODING_CPUS control-plane env ---

# --- WARDBY_DEPENDENCY_CACHE check ---
# Optional: true turns on the run dependency cache. It needs the bucket from
# deploy/gke/dependency-cache.tf (dependency_cache_enabled = true in
# terraform.tfvars). Empty = false, and then no blob-store env reaches the proxy.
WARDBY_DEPENDENCY_CACHE="${WARDBY_DEPENDENCY_CACHE:-false}"
case "$WARDBY_DEPENDENCY_CACHE" in
  true | false) ;;
  *)
    echo "up.sh: WARDBY_DEPENDENCY_CACHE must be true or false (got \"$WARDBY_DEPENDENCY_CACHE\")." >&2
    exit 1
    ;;
esac
if [[ "$WARDBY_DEPENDENCY_CACHE" = true ]]; then
  echo "up.sh: dependency cache is on."
else
  echo "up.sh: dependency cache is off."
fi
# --- end WARDBY_DEPENDENCY_CACHE check ---

# --- WARDBY_DEPENDENCY_CACHE proxy env ---
# Adds the blob-store env to the coding proxy's container, right after its
# DATABASE_URL entry (the one place that placeholder appears), in the proxy's
# own indentation. Does nothing unless the cache is on. The bucket comes from
# terraform (DEPENDENCY_CACHE_BUCKET, read after the apply); only the proxy
# gets it, because only the proxy's service account can reach the bucket.
inject_dependency_cache_env() {
  if [[ "$WARDBY_DEPENDENCY_CACHE" != true ]]; then
    cat
    return
  fi
  if ! [[ "${DEPENDENCY_CACHE_BUCKET:-}" =~ ^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$ ]]; then
    echo "up.sh: WARDBY_DEPENDENCY_CACHE=true but terraform has no dependency cache bucket (got \"${DEPENDENCY_CACHE_BUCKET:-}\"); set dependency_cache_enabled and dependency_cache_bucket_name in ${TF_DIR:-deploy/gke}/terraform.tfvars and re-run." >&2
    exit 1
  fi
  awk -v bucket="$DEPENDENCY_CACHE_BUCKET" '
    { print }
    /^ *value: wardby-proxy-database-url$/ {
      match($0, /^ */); value_indent = substr($0, 1, RLENGTH); item_indent = substr(value_indent, 3)
      print item_indent "- name: BLOB_STORE";                  print value_indent "value: \"gcs\""
      print item_indent "- name: BLOB_STORE_GCS_BUCKET";       print value_indent "value: \"" bucket "\""
      print item_indent "- name: WARDBY_DEPENDENCY_CACHE";     print value_indent "value: \"true\""
    }'
}
# --- end WARDBY_DEPENDENCY_CACHE proxy env ---

# --- WARDBY_SESSION_TRANSCRIPTS check ---
# Optional: true makes the control plane store the session transcripts of agents
# with sessionResume. It needs the bucket from deploy/gke/session-transcripts.tf
# (session_transcripts_enabled = true in terraform.tfvars). Empty = false, and
# then no blob-store env reaches the control plane. RUN_TRANSCRIPT_MAX_BYTES
# (optional) caps a transcript's size before compression.
WARDBY_SESSION_TRANSCRIPTS="${WARDBY_SESSION_TRANSCRIPTS:-false}"
case "$WARDBY_SESSION_TRANSCRIPTS" in
  true | false) ;;
  *)
    echo "up.sh: WARDBY_SESSION_TRANSCRIPTS must be true or false (got \"$WARDBY_SESSION_TRANSCRIPTS\")." >&2
    exit 1
    ;;
esac
RUN_TRANSCRIPT_MAX_BYTES="${RUN_TRANSCRIPT_MAX_BYTES:-}"
if [[ -n "$RUN_TRANSCRIPT_MAX_BYTES" ]]; then
  if ! [[ "$RUN_TRANSCRIPT_MAX_BYTES" =~ ^[1-9][0-9]{6,7}$ ]] \
    || ((RUN_TRANSCRIPT_MAX_BYTES < 1048576 || RUN_TRANSCRIPT_MAX_BYTES > 67108864)); then
    echo "up.sh: RUN_TRANSCRIPT_MAX_BYTES must be an integer between 1048576 and 67108864 (got \"$RUN_TRANSCRIPT_MAX_BYTES\")." >&2
    exit 1
  fi
fi
if [[ "$WARDBY_SESSION_TRANSCRIPTS" = true ]]; then
  echo "up.sh: session transcripts are on."
else
  echo "up.sh: session transcripts are off."
  if [[ -n "$RUN_TRANSCRIPT_MAX_BYTES" ]]; then
    echo "up.sh: RUN_TRANSCRIPT_MAX_BYTES is ignored while WARDBY_SESSION_TRANSCRIPTS is not true."
  fi
fi
# --- end WARDBY_SESSION_TRANSCRIPTS check ---

# --- WARDBY_SESSION_TRANSCRIPTS control-plane env ---
# Adds the blob-store env to the control plane's container, right after its
# WARDBY_MOBILE_ENABLED entry (a placeholder only the control plane has), in its
# own indentation. Does nothing unless transcripts are on. The bucket and the
# retention days come from terraform (SESSION_TRANSCRIPTS_BUCKET and
# SESSION_TRANSCRIPTS_RETENTION_DAYS, read after the apply), so the bucket's
# lifecycle rule and the control plane's RUN_TRANSCRIPT_RETENTION_DAYS always
# agree. Only the control plane gets it, because only the control plane's
# service account can reach the bucket; the coding proxy keeps its own
# (dependency cache) blob store, if any.
inject_session_transcripts_env() {
  if [[ "$WARDBY_SESSION_TRANSCRIPTS" != true ]]; then
    cat
    return
  fi
  if ! [[ "${SESSION_TRANSCRIPTS_BUCKET:-}" =~ ^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$ ]]; then
    echo "up.sh: WARDBY_SESSION_TRANSCRIPTS=true but terraform has no session transcripts bucket (got \"${SESSION_TRANSCRIPTS_BUCKET:-}\"); set session_transcripts_enabled and session_transcripts_bucket_name in ${TF_DIR:-deploy/gke}/terraform.tfvars and re-run." >&2
    exit 1
  fi
  if ! [[ "${SESSION_TRANSCRIPTS_RETENTION_DAYS:-}" =~ ^[1-9][0-9]{0,3}$ ]] \
    || ((SESSION_TRANSCRIPTS_RETENTION_DAYS > 3650)); then
    echo "up.sh: terraform's session_transcripts_retention_days output is not a whole number from 1 to 3650 (got \"${SESSION_TRANSCRIPTS_RETENTION_DAYS:-}\")." >&2
    exit 1
  fi
  awk -v bucket="$SESSION_TRANSCRIPTS_BUCKET" -v days="$SESSION_TRANSCRIPTS_RETENTION_DAYS" -v max_bytes="$RUN_TRANSCRIPT_MAX_BYTES" '
    { print }
    /^ *value: wardby_mobile_enabled$/ {
      match($0, /^ */); value_indent = substr($0, 1, RLENGTH); item_indent = substr(value_indent, 3)
      print item_indent "- name: BLOB_STORE";                     print value_indent "value: \"gcs\""
      print item_indent "- name: BLOB_STORE_GCS_BUCKET";          print value_indent "value: \"" bucket "\""
      print item_indent "- name: RUN_TRANSCRIPT_RETENTION_DAYS";  print value_indent "value: \"" days "\""
      if (max_bytes != "") { print item_indent "- name: RUN_TRANSCRIPT_MAX_BYTES"; print value_indent "value: \"" max_bytes "\"" }
    }'
}
# --- end WARDBY_SESSION_TRANSCRIPTS control-plane env ---

echo "==> 1/${TOTAL_STEPS} terraform: cluster, image registry, database"
terraform -chdir="$TF_DIR" init -input=false >/dev/null
terraform -chdir="$TF_DIR" apply -input=false -auto-approve

PROJECT_ID="$(terraform -chdir="$TF_DIR" output -raw project_id 2>/dev/null || grep -E '^\s*project_id' "$TF_DIR/terraform.tfvars" | head -1 | sed 's/.*=\s*"//; s/"//')"
REGION="$(terraform -chdir="$TF_DIR" output -raw region 2>/dev/null || echo us-central1)"
CLUSTER="$(terraform -chdir="$TF_DIR" output -raw cluster_name)"
REGISTRY="$(terraform -chdir="$TF_DIR" output -raw artifact_registry_url)"
DB_IP="$(terraform -chdir="$TF_DIR" output -raw private_ip_address)"
SECRET_PREFIX="$(terraform -chdir="$TF_DIR" output -raw secret_name_prefix)"
# Every output the IAM wiring needs, read into its own top-level variable --
# a plain VAR="$(terraform ... )" assignment is what set -e actually catches;
# a terraform failure nested inside a sed/printf argument is not guaranteed
# to abort the script at the point it happens.
CONNECTION="$(terraform -chdir="$TF_DIR" output -raw instance_connection_name)"
DB_NAME="$(terraform -chdir="$TF_DIR" output -raw database_name)"
APP_SERVICE_ACCOUNT="$(terraform -chdir="$TF_DIR" output -raw app_service_account)"
MIGRATOR_SERVICE_ACCOUNT="$(terraform -chdir="$TF_DIR" output -raw migrator_service_account)"
PROXY_SERVICE_ACCOUNT="$(terraform -chdir="$TF_DIR" output -raw proxy_service_account)"
APP_DATABASE_USER="$(terraform -chdir="$TF_DIR" output -raw app_database_user)"
MIGRATOR_DATABASE_USER="$(terraform -chdir="$TF_DIR" output -raw migrator_database_user)"
PROXY_DATABASE_USER="$(terraform -chdir="$TF_DIR" output -raw proxy_database_user)"
GATEWAY_SERVICE_ACCOUNT="$(terraform -chdir="$TF_DIR" output -raw gateway_service_account)"
GATEWAY_DATABASE_USER="$(terraform -chdir="$TF_DIR" output -raw gateway_database_user)"
# Empty unless dependency_cache_enabled; only consulted when WARDBY_DEPENDENCY_CACHE=true.
DEPENDENCY_CACHE_BUCKET="$(terraform -chdir="$TF_DIR" output -raw dependency_cache_bucket 2>/dev/null || true)"
# Empty unless session_transcripts_enabled; only consulted when WARDBY_SESSION_TRANSCRIPTS=true.
SESSION_TRANSCRIPTS_BUCKET="$(terraform -chdir="$TF_DIR" output -raw session_transcripts_bucket 2>/dev/null || true)"
SESSION_TRANSCRIPTS_RETENTION_DAYS="$(terraform -chdir="$TF_DIR" output -raw session_transcripts_retention_days 2>/dev/null || true)"
for var in CONNECTION DB_NAME APP_SERVICE_ACCOUNT MIGRATOR_SERVICE_ACCOUNT \
           PROXY_SERVICE_ACCOUNT APP_DATABASE_USER MIGRATOR_DATABASE_USER PROXY_DATABASE_USER \
           GATEWAY_SERVICE_ACCOUNT GATEWAY_DATABASE_USER; do
  [[ -n "${!var}" ]] || { echo "up.sh: terraform output for ${var} came back empty; is ${TF_DIR} applied?" >&2; exit 1; }
done
# postgresql://<IAM user, @ as %40>@127.0.0.1:5432/<database>: the Auth Proxy
# sidecar logs in; no password anywhere. Built only from the already-read,
# already-checked variables above -- no terraform call inside the helper.
iam_url() { printf 'postgresql://%s@127.0.0.1:5432/%s' "$(printf '%s' "$1" | sed 's/@/%40/')" "$DB_NAME"; }
APP_DATABASE_URL="$(iam_url "$APP_DATABASE_USER")"
MIGRATOR_DATABASE_URL="$(iam_url "$MIGRATOR_DATABASE_USER")"
PROXY_DATABASE_URL="$(iam_url "$PROXY_DATABASE_USER")"
GATEWAY_DATABASE_URL="$(iam_url "$GATEWAY_DATABASE_USER")"
iam_substitutions() {
  sed -e "s|wardby-instance-connection-name|${CONNECTION}|g" \
      -e "s|wardby-app-gsa-email|${APP_SERVICE_ACCOUNT}|g" \
      -e "s|wardby-migrator-gsa-email|${MIGRATOR_SERVICE_ACCOUNT}|g" \
      -e "s|wardby-proxy-gsa-email|${PROXY_SERVICE_ACCOUNT}|g" \
      -e "s|wardby-gateway-gsa-email|${GATEWAY_SERVICE_ACCOUNT}|g" \
      -e "s|value: wardby-app-database-url|value: ${APP_DATABASE_URL}|g" \
      -e "s|value: wardby-migrator-database-url|value: ${MIGRATOR_DATABASE_URL}|g" \
      -e "s|value: wardby-proxy-database-url|value: ${PROXY_DATABASE_URL}|g" \
      -e "s|value: wardby-gateway-database-url|value: ${GATEWAY_DATABASE_URL}|g"
}
# Belt and suspenders against the substitution list above going stale: every
# rendered manifest must be free of the wardby-*-gsa-email / *-database-url /
# instance-connection-name / migrate-job / database-cidr / *-image placeholders
# before it is applied. wardby-migrator and wardby-migrate (bare) are real
# resource names and must survive -- the patterns below only match the longer
# placeholder strings. The image pattern is anchored on the "value: " prefix
# every worker-image env var placeholder is rendered with, so it can never
# match a real registry path (which never starts with "wardby-").
assert_no_placeholders() {
  local leftover
  leftover="$(printf '%s' "$1" | grep -oE 'wardby-[a-z0-9-]*-gsa-email|wardby-[a-z0-9-]*-database-url|wardby-instance-connection-name|wardby-migrate-job|cidr: wardby-database-cidr|wardby-dbos-app-version|value: wardby-[a-z0-9-]*-image[a-z0-9-]*|value: wardby_github_allowed_accounts|value: wardby_mobile_enabled' || true)"
  if [[ -n "$leftover" ]]; then
    echo "up.sh: unresolved placeholder(s) in rendered manifest:" >&2
    echo "$leftover" | sort -u >&2
    exit 1
  fi
}

echo "==> 2/${TOTAL_STEPS} kubectl context for ${CLUSTER}"
gcloud container clusters get-credentials "$CLUSTER" --region "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1
export KUBE_CONTEXT="gke_${PROJECT_ID}_${REGION}_${CLUSTER}"
kubectl config use-context "$KUBE_CONTEXT" >/dev/null

# The API server by its ENDPOINT, not the kubernetes.default ClusterIP.
#
# On GKE Dataplane V2 the API server has its own Cilium identity, and NetworkPolicy
# ipBlock rules only ever match the `world` identity -- so no CIDR rule can reach
# the ClusterIP. Measured: the endpoint connects on 443 while the ClusterIP times
# out, both with 0.0.0.0/0 allowed and with an explicit Service-CIDR rule.
API_HOST="$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}' | sed -e 's|https://||' -e 's|:.*||')"

# hostname-change check: moving the public hostname breaks DNS, every client's configured
# endpoint, and every issued token (their audience names the old host), so a run that would
# change it stops for confirmation. Terraform (step 1) does not use the hostname.
LIVE_HOSTNAME="$(kubectl -n "$NAMESPACE" get gateway wardby-control-plane -o jsonpath='{.spec.listeners[0].hostname}' 2>/dev/null || true)"
if [[ -n "$LIVE_HOSTNAME" && "$LIVE_HOSTNAME" != "$WARDBY_HOSTNAME" ]]; then
  echo "up.sh: the live deployment is published on ${LIVE_HOSTNAME}; this run would move it to ${WARDBY_HOSTNAME}." >&2
  echo "       DNS, every client's endpoint, and every issued token are tied to ${LIVE_HOSTNAME}." >&2
  if [[ "${WARDBY_HOSTNAME_CHANGE:-}" == "$WARDBY_HOSTNAME" ]]; then
    echo "       Confirmed by WARDBY_HOSTNAME_CHANGE." >&2
  elif [[ -t 0 ]]; then
    read -r -p "       Type the new hostname to continue (anything else stops): " HOSTNAME_ANSWER
    if [[ "$HOSTNAME_ANSWER" != "$WARDBY_HOSTNAME" ]]; then
      echo "up.sh: hostname change not confirmed; nothing was rendered or applied." >&2
      exit 1
    fi
  else
    echo "up.sh: hostname change not confirmed. Re-run in a terminal, or set WARDBY_HOSTNAME_CHANGE=${WARDBY_HOSTNAME}." >&2
    exit 1
  fi
fi
# end hostname-change check

echo "==> 3/${TOTAL_STEPS} build and push images (linux/amd64)"
# Every image is built for linux/amd64 (deploy/gke/docker-bake.hcl): an arm64
# image lands in the registry, the pod fails to start, and the failure surfaces
# as a scheduling problem rather than an architecture one. bake builds them all
# concurrently from one context, and the Dockerfiles compile JavaScript on the
# builder's own platform, so an arm64 Mac only emulates what actually ships.
REGISTRY="$REGISTRY" docker buildx bake -f deploy/gke/docker-bake.hcl --load >/dev/null
IMAGES=(runtime migration coding-worker coding-worker-node-python claude-coding-worker claude-tool-runner claude-tool-runner-node-python native-worker)
PUSH_PIDS=()
for img in "${IMAGES[@]}"; do
  docker push "${REGISTRY}/${img}:latest" >/dev/null &
  PUSH_PIDS+=("$!")
done
for i in "${!PUSH_PIDS[@]}"; do
  if ! wait "${PUSH_PIDS[$i]}"; then
    echo "up.sh: pushing ${REGISTRY}/${IMAGES[$i]}:latest failed." >&2
    exit 1
  fi
done

# Digests, not tags. The launcher refuses a tag, and a digest is the only
# reference that still means the same bytes tomorrow.
digest_of() { docker inspect --format '{{index .RepoDigests 0}}' "${REGISTRY}/$1:latest"; }
RUNTIME_IMAGE="$(digest_of runtime)"
MIGRATION_IMAGE="$(digest_of migration)"
WORKER_IMAGE="$(digest_of coding-worker)"
WORKER_IMAGE_NODE_PYTHON="$(digest_of coding-worker-node-python)"
CLAUDE_WORKER_IMAGE="$(digest_of claude-coding-worker)"
CLAUDE_TOOL_RUNNER_IMAGE="$(digest_of claude-tool-runner)"
CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON="$(digest_of claude-tool-runner-node-python)"
NATIVE_WORKER_IMAGE="$(digest_of native-worker)"

echo "==> 4/${TOTAL_STEPS} verify the worker images have tar, head and test"
# Seeding and collection shell out to these. Without them every launch hangs
# until its deadline, with nothing naming the cause. The keeper of a Claude
# run runs from the Claude worker image, so it needs the same check.
for image in "$WORKER_IMAGE" "$WORKER_IMAGE_NODE_PYTHON" "$CLAUDE_WORKER_IMAGE"; do
  if ! docker run --rm --platform linux/amd64 --entrypoint sh "$image" -c 'command -v tar && command -v head && command -v test' >/dev/null; then
    echo "up.sh: worker image ${image} is missing tar, head or test." >&2
    exit 1
  fi
done
# The node-python image exists to run a Python project's own checks.
if ! docker run --rm --platform linux/amd64 --entrypoint sh "$WORKER_IMAGE_NODE_PYTHON" -c 'python --version && python -m pytest --version && python -m ruff --version' >/dev/null; then
  echo "up.sh: the node-python worker image is missing python, pytest or ruff." >&2
  exit 1
fi
# Claude's tool runner answers the pod's startup probe with `test -S`.
for image in "$CLAUDE_TOOL_RUNNER_IMAGE" "$CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON"; do
  if ! docker run --rm --platform linux/amd64 --entrypoint sh "$image" -c 'command -v test' >/dev/null; then
    echo "up.sh: the Claude tool runner image ${image} is missing test." >&2
    exit 1
  fi
done
# Claude's node-python tool runner runs a Python project's own checks, like the Codex one.
if ! docker run --rm --platform linux/amd64 --entrypoint sh "$CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON" -c 'python --version && python -m pytest --version && python -m ruff --version' >/dev/null; then
  echo "up.sh: the Claude node-python tool runner image is missing python, pytest or ruff." >&2
  exit 1
fi

# The native sandbox worker: its in-pod isolation probe runs `node`, and it carries no network
# tooling a tool escape could use (its Dockerfile asserts the same at build time).
if ! docker run --rm --platform linux/amd64 --entrypoint sh "$NATIVE_WORKER_IMAGE" -c \
  'command -v node && for t in curl wget nc ssh; do ! command -v "$t"; done' >/dev/null; then
  echo "up.sh: the native worker image is missing node or carries network tooling." >&2
  exit 1
fi

echo "==> 5/${TOTAL_STEPS} seed Secret Manager"
# Fills only empty secrets: from the live cluster (so existing keys carry over),
# then .env.local, then -- for the two auth keys only -- a new random key. Values
# go over stdin and are never printed. Stops before writing anything if a value
# has no source.
# Optional groups (Jira, Slack) are seeded all or none; the ones fully set are
# listed in SEED_GROUPS_FILE for step 7.
SEED_GROUPS_FILE="$(mktemp)"
node deploy/gke/seed-secrets.mjs --project "$PROJECT_ID" --prefix "$SECRET_PREFIX" \
  --context "$KUBE_CONTEXT" --namespace "$NAMESPACE" --groups-out "$SEED_GROUPS_FILE"
JIRA_ENABLED=0
grep -qx jira "$SEED_GROUPS_FILE" && JIRA_ENABLED=1
SLACK_ENABLED=0
grep -qx slack "$SEED_GROUPS_FILE" && SLACK_ENABLED=1
rm -f "$SEED_GROUPS_FILE"

echo "==> 6/${TOTAL_STEPS} External Secrets Operator ${ESO_CHART_VERSION}, scoped to ${NAMESPACE}"
# The namespace first: the scoped chart creates its Role and RoleBinding in it.
kubectl apply -f deploy/kind-coding/manifests/base/namespace.yaml >/dev/null
helm upgrade --install external-secrets external-secrets --repo "$ESO_CHART_REPO" \
  --version "$ESO_CHART_VERSION" --kube-context "$KUBE_CONTEXT" \
  --namespace external-secrets --create-namespace \
  --values deploy/gke/eso-values.yaml --wait --timeout 10m >/dev/null

echo "==> 7/${TOTAL_STEPS} sync the Secrets from Secret Manager"
SECRETS_DIR="deploy/kind-coding/manifests/overlays/gke-autopilot/secrets"
render_secrets() {
  sed -e "s|wardby-gcp-project|${PROJECT_ID}|g" \
      -e "s|wardby-cluster-location|${REGION}|g" \
      -e "s|wardby-cluster-name|${CLUSTER}|g" \
      -e "s|wardby-secret-prefix|${SECRET_PREFIX}|g" \
      "${SECRETS_DIR}/$1"
}
export NAMESPACE
# The order is what keeps the live Secrets safe. Nothing is deleted until a real
# read from Secret Manager has succeeded, which only the real cluster can prove
# (Workload Identity does not exist on kind).
render_secrets store.yaml | kubectl apply -f - >/dev/null
if ! render_secrets canary.yaml | run_secrets_canary 180s; then
  echo "up.sh: External Secrets cannot read Secret Manager; the existing Secrets were not touched." >&2
  exit 1
fi
# Before the real ExternalSecrets exist, so ESO creates both Secrets fresh
# rather than adopting the hand-made ones and their old annotations. Safe
# because step 5 put every value in Secret Manager and the canary read every
# key.
release_unowned_secrets wardby-coding-proxy-env wardby-control-plane-env wardby-native-gateway-env
if ! render_secrets external-secrets.yaml | kubectl apply -f - >/dev/null; then
  echo "up.sh: applying the ExternalSecrets failed after the hand-made Secrets were released; running pods are unaffected. Re-run up.sh to finish." >&2
  exit 1
fi
# Forces a sync and waits for a fresh one, so a secret version that step 5
# just added (e.g. a newly generated auth key) is in the Secret before step 10
# rolls the Deployments.
SYNCED_SECRETS=(wardby-coding-proxy-env wardby-control-plane-env wardby-native-gateway-env)
# Jira is optional: synced when every Jira secret is set, removed when none is
# (the control plane reads wardby-jira-env with optional: true).
if ((JIRA_ENABLED)); then
  echo "    Jira is configured; syncing wardby-jira-env"
  if ! render_secrets external-secrets-jira.yaml | kubectl apply -f - >/dev/null; then
    echo "up.sh: applying the Jira ExternalSecret failed; running pods are unaffected." >&2
    exit 1
  fi
  SYNCED_SECRETS+=(wardby-jira-env)
else
  kubectl -n "$NAMESPACE" delete externalsecret wardby-jira-env --ignore-not-found >/dev/null
fi
# Slack notifications are optional the same way (wardby-slack-env, optional: true).
if ((SLACK_ENABLED)); then
  echo "    Slack is configured; syncing wardby-slack-env"
  if ! render_secrets external-secrets-slack.yaml | kubectl apply -f - >/dev/null; then
    echo "up.sh: applying the Slack ExternalSecret failed; running pods are unaffected." >&2
    exit 1
  fi
  SYNCED_SECRETS+=(wardby-slack-env)
else
  kubectl -n "$NAMESPACE" delete externalsecret wardby-slack-env --ignore-not-found >/dev/null
fi
if ! wait_external_secrets_synced 180s "${SYNCED_SECRETS[@]}"; then
  echo "up.sh: the Secrets did not sync from Secret Manager; nothing else was applied." >&2
  exit 1
fi

echo "==> 8/${TOTAL_STEPS} run migrations as wardby-migrator"
# Before the grants and the Deployments, so a failed migration stops the
# deploy with the running version untouched.
#
# Applied as two separate `kubectl apply` calls -- migrator.yaml (the
# ServiceAccount and its NetworkPolicy) before job.yaml (the Job itself) --
# rather than kubectl kustomize's combined multi-document output, so the
# Job's pod can never be scheduled before its own NetworkPolicy exists.
# migrate/kustomization.yaml does no transform beyond listing the two files
# today, so substituting and applying them directly is equivalent to its
# kustomize output.
MIGRATOR_MANIFEST="$(sed -e "s|cidr: wardby-database-cidr|cidr: ${DB_IP}/32|g" \
    deploy/kind-coding/manifests/overlays/gke-autopilot/migrate/migrator.yaml \
  | iam_substitutions)"
assert_no_placeholders "$MIGRATOR_MANIFEST"
echo "$MIGRATOR_MANIFEST" | kubectl apply -f - >/dev/null

MIGRATE_JOB="wardby-migrate-$(date +%s)"
JOB_MANIFEST="$(sed -e "s|image: wardby-migration|image: ${MIGRATION_IMAGE}|" \
                     -e "s|wardby-migrate-job|${MIGRATE_JOB}|g" \
    deploy/kind-coding/manifests/overlays/gke-autopilot/migrate/job.yaml \
  | iam_substitutions)"
assert_no_placeholders "$JOB_MANIFEST"
echo "$JOB_MANIFEST" | kubectl apply -f - >/dev/null

# reason ("" unless timed_out) is cosmetic; timed_out selects the message and
# forces the events dump even when a log happened to come back non-empty.
migration_failed() {
  local reason="$1" timed_out="${2:-false}"
  local migrate_logs proxy_logs proxy_prev_logs pod
  if [[ "$timed_out" == "true" ]]; then
    echo "up.sh: migration timed out: ${reason}." >&2
  else
    echo "up.sh: migration Job ${MIGRATE_JOB} did not succeed (${reason}):" >&2
  fi
  migrate_logs="$(kubectl -n "$NAMESPACE" logs "job/${MIGRATE_JOB}" -c migrate --tail=40 2>/dev/null || true)"
  proxy_logs="$(kubectl -n "$NAMESPACE" logs "job/${MIGRATE_JOB}" -c cloud-sql-proxy --tail=40 2>/dev/null || true)"
  # --previous: a crash-looping sidecar (e.g. bad IAM/Workload Identity setup)
  # can already be on its second or later attempt by the time this runs, and
  # the current attempt's logs alone would miss the actual error.
  proxy_prev_logs="$(kubectl -n "$NAMESPACE" logs "job/${MIGRATE_JOB}" -c cloud-sql-proxy --previous --tail=40 2>/dev/null || true)"
  echo "--- migrate container logs ---" >&2
  echo "${migrate_logs:-(no logs)}" >&2
  echo "--- cloud-sql-proxy sidecar logs ---" >&2
  echo "${proxy_logs:-(no logs)}" >&2
  if [[ -n "$proxy_prev_logs" ]]; then
    echo "--- cloud-sql-proxy sidecar logs (--previous, crash-looping container) ---" >&2
    echo "$proxy_prev_logs" >&2
  fi
  if [[ "$timed_out" == "true" || ( -z "$migrate_logs" && -z "$proxy_logs" ) ]]; then
    echo "--- kubectl get events (job ${MIGRATE_JOB}) ---" >&2
    kubectl -n "$NAMESPACE" get events --field-selector "involvedObject.name=${MIGRATE_JOB}" >&2 || true
    pod="$(kubectl -n "$NAMESPACE" get pods -l job-name="$MIGRATE_JOB" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
    if [[ -n "$pod" ]]; then
      echo "--- kubectl get events (pod ${pod}) ---" >&2
      kubectl -n "$NAMESPACE" get events --field-selector "involvedObject.name=${pod}" >&2 || true
    fi
  fi
  if echo "$migrate_logs" | grep -qi "permission denied"; then
    echo "up.sh: the database grants look missing; run deploy/gke/bootstrap-database-iam.sh (docs/getting-started-gke.md, \"Database login\")." >&2
  fi
  exit 1
}
# Budget (960s) deliberately exceeds the Job's own activeDeadlineSeconds
# (900s, migrate/job.yaml): the Job's own deadline is meant to fire first, and
# this loop finishing first would mean the Job is stuck without Kubernetes
# itself having noticed.
MIGRATE_POLL_INTERVAL=5
MIGRATE_POLL_ITERATIONS=192 # 192 * 5s = 960s
for i in $(seq 1 "$MIGRATE_POLL_ITERATIONS"); do
  # succeeded, the Failed condition's status and its reason, '|'-delimited so
  # an empty field (nothing has failed yet) doesn't shift the others -- IFS
  # whitespace-splitting would. A single failed read retries rather than
  # aborting: status stays "||" (all fields empty), which is indistinguishable
  # from "still running" below, so the loop just tries again next iteration.
  status="$(kubectl -n "$NAMESPACE" get job "$MIGRATE_JOB" -o \
    jsonpath='{.status.succeeded}|{.status.conditions[?(@.type=="Failed")].status}|{.status.conditions[?(@.type=="Failed")].reason}' \
    2>/dev/null)" || status="||"
  IFS='|' read -r succeeded failed_condition failed_reason <<<"$status"
  [[ "$succeeded" == "1" ]] && break
  if [[ "$failed_condition" == "True" ]]; then
    if [[ "$failed_reason" == "DeadlineExceeded" ]]; then
      migration_failed "the Job's activeDeadlineSeconds (900s) was exceeded" true
    else
      migration_failed "Failed condition, reason ${failed_reason:-unknown}" false
    fi
  fi
  if [[ "$i" == "$MIGRATE_POLL_ITERATIONS" ]]; then
    migration_failed "up.sh's own poll budget (${MIGRATE_POLL_ITERATIONS}x${MIGRATE_POLL_INTERVAL}s) ran out waiting for the Job" true
  fi
  sleep "$MIGRATE_POLL_INTERVAL"
done
echo "    migrations applied"

echo "==> 9/${TOTAL_STEPS} apply database grants"
# After the migrations, so a grant on a table this release adds has its table,
# and before the overlay, so no new pod ever runs without the grants it needs.
# bootstrap-database-iam.sh (default mode) applies database-grants.sql in one
# transaction as the built-in owner, through a one-time password it resets on
# every exit. It reads the same Terraform outputs, and KUBE_CONTEXT (exported in
# step 2). A failure stops here with the running version untouched; the
# migrations already applied are additive, which the running version tolerates.
# database grants
if ! bash deploy/gke/bootstrap-database-iam.sh; then
  echo "up.sh: applying the database grants failed; nothing was rolled out and the running version is untouched. Fix the cause above, then run up.sh again: a refused statement (deploy/gke/bootstrap-database-iam.sh --check reproduces it without changing anything), or a warning that resetting the owner password failed -- the next run sets and resets it again." >&2
  exit 1
fi
# end database grants

echo "==> 10/${TOTAL_STEPS} render and apply the overlay (low-power mode: ${LOW_POWER_LABEL})"
# What is running now, recorded before it is replaced: rollback means going back
# to exactly these digests (see the rollback note at the end).
PREVIOUS_IMAGES="$(kubectl -n "$NAMESPACE" get deploy wardby-control-plane wardby-coding-proxy wardby-native-gateway \
  -o jsonpath='{range .items[*]}{.metadata.name}={.spec.template.spec.containers[0].image}{"\n"}{end}' 2>/dev/null || true)"
# Every value below is target identity: it is substituted here and never
# committed. The placeholders are the contract between this script and the
# tracked manifests.
#
# DBOS__APPVERSION is the runtime image's digest (sha256:...): the durable
# executor resumes a run only under the version that recorded it, so a re-run of
# this script with unchanged source keeps in-flight runs across the rollout, and
# a deploy of new code does not replay old checkpoints against it (those runs
# end lost, as they would without the durable executor).
OVERLAY_MANIFEST="$(kubectl kustomize "$OVERLAY" \
  | inject_dependency_cache_env \
  | inject_session_transcripts_env \
  | inject_mention_explanations_env \
  | inject_coding_max_disk_env \
  | inject_coding_resources_env \
  | sed -e "s|image: wardby-runtime|image: ${RUNTIME_IMAGE}|" \
        -e "s|value: wardby-dbos-app-version|value: \"${RUNTIME_IMAGE##*@}\"|" \
        -e "s|value: wardby-coding-worker-image-node-python-3-12$|value: ${WORKER_IMAGE_NODE_PYTHON}|" \
        -e "s|value: wardby-claude-tool-runner-image-node-python-3-12$|value: ${CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON}|" \
        -e "s|value: wardby-claude-tool-runner-image$|value: ${CLAUDE_TOOL_RUNNER_IMAGE}|" \
        -e "s|value: wardby-claude-coding-worker-image$|value: ${CLAUDE_WORKER_IMAGE}|" \
        -e "s|value: wardby-coding-worker-image$|value: ${WORKER_IMAGE}|" \
        -e "s|value: wardby-native-worker-image$|value: ${NATIVE_WORKER_IMAGE}|" \
        -e "s|value: wardby-apiserver-host|value: ${API_HOST}|" \
        -e "s|wardby-control-plane-hostname|${WARDBY_HOSTNAME}|g" \
        -e "s|value: wardby_github_allowed_accounts$|value: \"${WARDBY_GITHUB_ALLOWED_ACCOUNTS}\"|" \
        -e "s|value: wardby_mobile_enabled$|value: \"${WARDBY_MOBILE_ENABLED}\"|" \
        -e "s|cidr: wardby-database-cidr|cidr: ${DB_IP}/32|g" \
  | iam_substitutions)"
assert_no_placeholders "$OVERLAY_MANIFEST"
# low-power pre-apply
# The apply brings a sleeping proxy and gateway back to 1+ replicas, while the
# control plane still running serves until its rollout ends -- and that one may
# be in low-power mode even when this deploy turns the mode off. Stamp both as
# just woken first, in either mode, so it does not scale them straight back to
# 0 mid-deploy (and steps 11-12 find their pods). With the mode off the stamp is
# never read again. A Deployment not created yet is skipped.
LOW_POWER_WOKE_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
for low_power_target in wardby-coding-proxy wardby-native-gateway; do
  low_power_found="$(kubectl -n "$NAMESPACE" get deploy "$low_power_target" --ignore-not-found -o name)"
  if [ -n "$low_power_found" ]; then
    kubectl -n "$NAMESPACE" annotate "deploy/$low_power_target" "wardby.io/power-woke-at=$LOW_POWER_WOKE_AT" --overwrite >/dev/null
  fi
done
if [ "$LOW_POWER" = 0 ]; then
  # Leaving low-power mode: drop the control plane's HPA before the apply sets
  # its replicas: 1, so the HPA cannot rescale it in between. A no-op when
  # low-power mode was never on.
  kubectl -n "$NAMESPACE" delete hpa/wardby-control-plane --ignore-not-found >/dev/null
fi
# end low-power pre-apply
echo "$OVERLAY_MANIFEST" | kubectl apply -f - >/dev/null
# low-power undo
if [ "$LOW_POWER" = 0 ]; then
  # Leaving low-power mode: remove the rest of what only it applies. The plain
  # overlay has already restored proxy 1 / gateway 2 / headroom 1 replicas, and
  # the control plane's own replicas: 1. A no-op when low-power mode was never on.
  kubectl -n "$NAMESPACE" delete role/wardby-power rolebinding/wardby-power --ignore-not-found >/dev/null
fi
# end low-power undo

echo "==> 11/${TOTAL_STEPS} wait for rollouts"
kubectl -n "$NAMESPACE" rollout status deploy/wardby-coding-proxy --timeout=300s
kubectl -n "$NAMESPACE" rollout status deploy/wardby-native-gateway --timeout=300s
if ! kubectl -n "$NAMESPACE" rollout status deploy/wardby-control-plane --timeout=600s; then
  # The previous pod keeps serving (maxUnavailable 0). The durable executor
  # launches before anything else, so a missing `dbos` schema grant shows here
  # as a crash loop rather than in step 12.
  echo "up.sh: the control plane did not roll out. If its log shows \"permission denied\" for the database or schema \"dbos\", the durable executor's grants are missing even though step 9 applied database-grants.sql: check that the file covers what this release uses (docs/getting-started-gke.md, \"Durable executor\")." >&2
  exit 1
fi
# failed always-on pods
# A replica the node rejected at admission (Autopilot's OutOfcpu race during a
# rollout) stays as a Failed pod next to its healthy replacement until
# something deletes it. Remove those for the three always-on Deployments only:
# failed coding-run and sandbox pods are the launchers' to collect.
kubectl -n "$NAMESPACE" delete pods --field-selector=status.phase=Failed --ignore-not-found \
  -l 'app.kubernetes.io/name in (wardby-control-plane,wardby-coding-proxy,wardby-native-gateway)' >/dev/null
# end failed always-on pods

echo "==> 12/${TOTAL_STEPS} prove the new pods can use the database"
# A Ready pod has not necessarily touched the database: the control plane and
# the coding proxy each run one query through their own Prisma client, Auth
# Proxy sidecar and database role. The query runs in the container itself
# (runtime image, WORKDIR /app), through the image's own client factory,
# dist/core/db.js (the generated client in dist/generated/prisma plus the pg
# driver adapter -- the same code path the app uses), with the pod's own
# DATABASE_URL, which is never printed: only "... reads the database" or the
# error message, with any connection URL in it masked.
#
# The pod is picked explicitly rather than via deploy/<name>: rollout status
# has returned, so the only Running pods not being deleted belong to the new
# ReplicaSet, while a draining old pod could otherwise be the one exec picks.
new_pod() {
  kubectl -n "$NAMESPACE" get pods -l "app.kubernetes.io/name=$1" \
    -o jsonpath='{range .items[*]}{.metadata.name} {.status.phase} {.metadata.deletionTimestamp}{"\n"}{end}' \
    | awk '$2 == "Running" && $3 == "" { print $1; exit }'
}
database_roundtrip() {
  local app="$1" container="$2" table="$3" label="$4" pod out script
  script='const mask = (m) => String(m).replace(/postgres(ql)?:\/\/[^\s\x60\x27"]+/gi, "<database url>");
setTimeout(() => { console.error("no answer from the database in 30s"); process.exit(1); }, 30000);
import("/app/dist/core/db.js")
  .then(({ createPrismaClient }) => createPrismaClient().$queryRawUnsafe(`SELECT 1 FROM "'"$table"'" LIMIT 1`))
  .then(
    () => process.exit(0),
    (e) => { console.error(mask(e && e.message ? e.message : e)); process.exit(1); },
  );'
  pod="$(new_pod "$app")"
  if [[ -z "$pod" ]]; then
    echo "up.sh: no running ${app} pod to check." >&2
    return 1
  fi
  if out="$(kubectl -n "$NAMESPACE" exec "pod/${pod}" -c "$container" -- node --input-type=commonjs -e "$script" 2>&1)"; then
    echo "    ${label} reads the database"
    return 0
  fi
  echo "up.sh: the ${label} (pod ${pod}) cannot use the database:" >&2
  echo "${out:-(no output)}" >&2
  echo "--- cloud-sql-proxy sidecar, last 20 lines ---" >&2
  kubectl -n "$NAMESPACE" logs "pod/${pod}" -c cloud-sql-proxy --tail=20 >&2 || true
  return 1
}
DATABASE_OK=true
database_roundtrip wardby-control-plane control-plane Agent "control plane" || DATABASE_OK=false
database_roundtrip wardby-coding-proxy proxy CodingProxySession "coding proxy" || DATABASE_OK=false
database_roundtrip wardby-native-gateway gateway NativeGatewaySession "native gateway" || DATABASE_OK=false
# proxy grants check
# Step 9 applied database-grants.sql; this proves it took, as the proxy's own
# role, inside its pod. A proxy missing a grant fails every registry request
# with "permission denied" (an unlogged 502 to npm or pip), so check every
# privilege database-grants.sql gives wardby_proxy rather than trust the step.
proxy_grants_check() {
  local pod query out script
  query="$(node deploy/gke/proxy-grant-checks.mjs)" || return 1
  script='const mask = (m) => String(m).replace(/postgres(ql)?:\/\/[^\s\x60\x27"]+/gi, "<database url>");
setTimeout(() => { console.error("no answer from the database in 30s"); process.exit(1); }, 30000);
import("/app/dist/core/db.js")
  .then(({ createPrismaClient }) => createPrismaClient().$queryRawUnsafe('"$(node -e 'process.stdout.write(JSON.stringify(process.argv[1]))' "$query")"'))
  .then(
    (rows) => { for (const row of rows) console.log(row.grant); process.exit(rows.length === 0 ? 0 : 2); },
    (e) => { console.error(mask(e && e.message ? e.message : e)); process.exit(1); },
  );'
  pod="$(new_pod wardby-coding-proxy)"
  [[ -n "$pod" ]] || { echo "up.sh: no running wardby-coding-proxy pod to check grants in." >&2; return 1; }
  if out="$(kubectl -n "$NAMESPACE" exec "pod/${pod}" -c proxy -- node --input-type=commonjs -e "$script" 2>&1)"; then
    echo "    coding proxy has every grant in database-grants.sql"
    return 0
  fi
  echo "up.sh: the coding proxy is missing database grants that database-grants.sql gives it:" >&2
  echo "${out:-(no output)}" | sed 's/^/    /' >&2
  echo "up.sh: step 9 should have applied these; run deploy/gke/bootstrap-database-iam.sh --check to see whether the database refuses one, then up.sh again." >&2
  return 1
}
proxy_grants_check || DATABASE_OK=false
if ! $DATABASE_OK; then
  cat >&2 <<EOF
up.sh: the new pods cannot use the database.
  kubectl -n ${NAMESPACE} rollout undo deploy/wardby-control-plane
  kubectl -n ${NAMESPACE} rollout undo deploy/wardby-coding-proxy
  kubectl -n ${NAMESPACE} rollout undo deploy/wardby-native-gateway
restores the previous images and pod templates, which also log in through IAM.
"permission denied" means the grants are missing or incomplete even though
step 9 applied database-grants.sql: check that the file covers every table and
column the release uses, and run deploy/gke/bootstrap-database-iam.sh --check
to see whether the database refuses a statement (docs/getting-started-gke.md,
"Database login"). Then up.sh again.
EOF
  exit 1
fi
# end proxy grants check

echo "==> 13/${TOTAL_STEPS} verify the public endpoint"
# A finished rollout proves the pods are Ready, not that the load balancer routes
# to them or that authentication is enforced. These are the same checks an
# operator would run by hand, made to fail the deploy instead of scrolling past.
#
# Run only once every old control-plane pod is gone. While one is still draining
# it answers for the new pod, and on 2026-09-24 a check made then passed and the
# endpoint went down ~90s later. Then require a steady minute of 200s, not one.
for i in $(seq 1 60); do
  [[ -z "$(kubectl -n "$NAMESPACE" get pods -l app.kubernetes.io/name=wardby-control-plane \
    -o jsonpath='{.items[?(@.metadata.deletionTimestamp)].metadata.name}')" ]] && break
  sleep 5
done
MCP_INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
expect_status() {
  local want="$1" got="" i
  shift
  for i in $(seq 1 18); do
    got="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$@" 2>/dev/null || true)"
    [[ "$got" == "$want" ]] && return 0
    sleep 10
  done
  echo "up.sh: expected HTTP ${want}, got ${got:-no response}: $*" >&2
  return 1
}
expect_status 200 "https://${WARDBY_HOSTNAME}/.well-known/oauth-protected-resource"
for i in $(seq 1 12); do
  got="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://${WARDBY_HOSTNAME}/.well-known/oauth-protected-resource" 2>/dev/null || true)"
  if [[ "$got" != "200" ]]; then
    echo "up.sh: discovery answered ${got:-no response} ${i} checks after it first answered 200; the endpoint is not stable." >&2
    exit 1
  fi
  sleep 5
done
echo "    discovery answers 200, steadily for a minute"
expect_status 401 -X POST "https://${WARDBY_HOSTNAME}/mcp" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' -d "$MCP_INIT"
echo "    unauthenticated MCP is refused with 401"

cat <<EOF

Done. The control plane is running in ${CLUSTER}.

  MCP endpoint : https://${WARDBY_HOSTNAME}/mcp
  database     : ${DB_IP} (private IP, reached only through the Auth Proxy)
  images       : ${REGISTRY}
  secrets      : Secret Manager, prefix ${SECRET_PREFIX} (synced by External Secrets)

Still manual, because neither belongs in a script:

  * The Gateway needs a DNS A record for ${WARDBY_HOSTNAME} pointing at the reserved
    address, and a Google-managed certificate. Use DNS authorization rather than
    load-balancer authorization -- the latter needs the hostname to already
    resolve, which it will not before the endpoint exists.
  * A login key: self-hosted auth has no signup over HTTP, so mint one with
      kubectl exec -n ${NAMESPACE} deploy/wardby-control-plane -c control-plane -- \\
        node dist/cli.js auth user create --subject <you> --role admin
    It is printed once and is a bearer credential valid for a year. --role admin
    allows the privileged operations; other users default to no roles. After an
    upgrade, existing users have no roles: auth user grant --subject <you> --role admin

Roll back (images are pinned by digest, so this is exactly what ran before):
  kubectl -n ${NAMESPACE} rollout undo deploy/wardby-control-plane
  kubectl -n ${NAMESPACE} rollout undo deploy/wardby-coding-proxy
  kubectl -n ${NAMESPACE} rollout undo deploy/wardby-native-gateway
Images before this deploy:
${PREVIOUS_IMAGES:-  (none: first deploy)}
Migrations only go forward, so a rollback is safe only while the schema change it
rolls back over was additive. See docs/getting-started-gke.md, "Roll back".
rollout undo reverts only the Deployments' images and pod templates. It does
not touch the database grants or any NetworkPolicy:
a change to the database egress rules themselves is not undone by rollout undo.
EOF
