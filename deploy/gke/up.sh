#!/usr/bin/env bash
#
# Stands up a wardby control plane on GKE Autopilot, from Terraform through to a
# serving MCP endpoint.
#
#   HOSTNAME=app.example.com deploy/gke/up.sh
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

for tool in terraform gcloud kubectl docker helm node; do
  command -v "$tool" >/dev/null || { echo "up.sh: ${tool} is required." >&2; exit 1; }
done

TF_DIR="deploy/gke"
OVERLAY="deploy/kind-coding/manifests/overlays/gke-autopilot"
NAMESPACE="wardby-coding"
TOTAL_STEPS=12

: "${HOSTNAME:?set HOSTNAME to the hostname the MCP endpoint is published on (e.g. app.example.com)}"

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
for var in CONNECTION DB_NAME APP_SERVICE_ACCOUNT MIGRATOR_SERVICE_ACCOUNT \
           PROXY_SERVICE_ACCOUNT APP_DATABASE_USER MIGRATOR_DATABASE_USER PROXY_DATABASE_USER; do
  [[ -n "${!var}" ]] || { echo "up.sh: terraform output for ${var} came back empty; is ${TF_DIR} applied?" >&2; exit 1; }
done
# postgresql://<IAM user, @ as %40>@127.0.0.1:5432/<database>: the Auth Proxy
# sidecar logs in; no password anywhere. Built only from the already-read,
# already-checked variables above -- no terraform call inside the helper.
iam_url() { printf 'postgresql://%s@127.0.0.1:5432/%s' "$(printf '%s' "$1" | sed 's/@/%40/')" "$DB_NAME"; }
APP_DATABASE_URL="$(iam_url "$APP_DATABASE_USER")"
MIGRATOR_DATABASE_URL="$(iam_url "$MIGRATOR_DATABASE_USER")"
PROXY_DATABASE_URL="$(iam_url "$PROXY_DATABASE_USER")"
iam_substitutions() {
  sed -e "s|wardby-instance-connection-name|${CONNECTION}|g" \
      -e "s|wardby-app-gsa-email|${APP_SERVICE_ACCOUNT}|g" \
      -e "s|wardby-migrator-gsa-email|${MIGRATOR_SERVICE_ACCOUNT}|g" \
      -e "s|wardby-proxy-gsa-email|${PROXY_SERVICE_ACCOUNT}|g" \
      -e "s|value: wardby-app-database-url|value: ${APP_DATABASE_URL}|g" \
      -e "s|value: wardby-migrator-database-url|value: ${MIGRATOR_DATABASE_URL}|g" \
      -e "s|value: wardby-proxy-database-url|value: ${PROXY_DATABASE_URL}|g"
}
# Belt and suspenders against the substitution list above going stale: every
# rendered manifest must be free of the wardby-*-gsa-email / *-database-url /
# instance-connection-name / migrate-job / database-cidr placeholders before
# it is applied. wardby-migrator and wardby-migrate (bare) are real resource
# names and must survive -- the patterns below only match the longer
# placeholder strings.
assert_no_placeholders() {
  local leftover
  leftover="$(printf '%s' "$1" | grep -oE 'wardby-[a-z0-9-]*-gsa-email|wardby-[a-z0-9-]*-database-url|wardby-instance-connection-name|wardby-migrate-job|cidr: wardby-database-cidr' || true)"
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

echo "==> 3/${TOTAL_STEPS} build and push images (linux/amd64)"
# --platform is not optional on an arm64 Mac: an arm64 image lands in the
# registry, the pod fails to start, and the failure surfaces as a scheduling
# problem rather than an architecture one.
docker build --platform linux/amd64 --target runtime -t "${REGISTRY}/runtime:latest" -f deploy/Dockerfile . >/dev/null
docker build --platform linux/amd64 --target migration -t "${REGISTRY}/migration:latest" -f deploy/Dockerfile . >/dev/null
docker build --platform linux/amd64 -t "${REGISTRY}/coding-worker:latest" -f src/coding-worker/Dockerfile . >/dev/null
docker build --platform linux/amd64 -t "${REGISTRY}/coding-worker-node-python:latest" -f src/coding-worker/Dockerfile.node-python . >/dev/null
for img in runtime migration coding-worker coding-worker-node-python; do docker push "${REGISTRY}/${img}:latest" >/dev/null; done

# Digests, not tags. The launcher refuses a tag, and a digest is the only
# reference that still means the same bytes tomorrow.
digest_of() { docker inspect --format '{{index .RepoDigests 0}}' "${REGISTRY}/$1:latest"; }
RUNTIME_IMAGE="$(digest_of runtime)"
MIGRATION_IMAGE="$(digest_of migration)"
WORKER_IMAGE="$(digest_of coding-worker)"
WORKER_IMAGE_NODE_PYTHON="$(digest_of coding-worker-node-python)"

echo "==> 4/${TOTAL_STEPS} verify the worker images have tar, head and test"
# Seeding and collection shell out to these. Without them every launch hangs
# until its deadline, with nothing naming the cause.
for image in "$WORKER_IMAGE" "$WORKER_IMAGE_NODE_PYTHON"; do
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

echo "==> 5/${TOTAL_STEPS} seed Secret Manager"
# Fills only empty secrets: from the live cluster (so existing keys carry over),
# then .env.local, then -- for the two auth keys only -- a new random key. Values
# go over stdin and are never printed. Stops before writing anything if a value
# has no source.
node deploy/gke/seed-secrets.mjs --project "$PROJECT_ID" --prefix "$SECRET_PREFIX" \
  --context "$KUBE_CONTEXT" --namespace "$NAMESPACE"

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
release_unowned_secrets wardby-coding-proxy-env wardby-control-plane-env
if ! render_secrets external-secrets.yaml | kubectl apply -f - >/dev/null; then
  echo "up.sh: applying the ExternalSecrets failed after the hand-made Secrets were released; running pods are unaffected. Re-run up.sh to finish." >&2
  exit 1
fi
# Forces a sync and waits for a fresh one, so a secret version that step 5
# just added (e.g. a newly generated auth key) is in the Secret before step 9
# rolls the Deployments.
if ! wait_external_secrets_synced 180s wardby-coding-proxy-env wardby-control-plane-env; then
  echo "up.sh: the Secrets did not sync from Secret Manager; nothing else was applied." >&2
  exit 1
fi

echo "==> 8/${TOTAL_STEPS} run migrations as wardby-migrator"
# Before the Deployments, so a failed migration stops the deploy with the
# running version untouched.
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

echo "==> 9/${TOTAL_STEPS} render and apply the overlay"
# What is running now, recorded before it is replaced: rollback means going back
# to exactly these digests (see the rollback note at the end).
PREVIOUS_IMAGES="$(kubectl -n "$NAMESPACE" get deploy wardby-control-plane wardby-coding-proxy \
  -o jsonpath='{range .items[*]}{.metadata.name}={.spec.template.spec.containers[0].image}{"\n"}{end}' 2>/dev/null || true)"
# Every value below is target identity: it is substituted here and never
# committed. The placeholders are the contract between this script and the
# tracked manifests.
OVERLAY_MANIFEST="$(kubectl kustomize "$OVERLAY" \
  | sed -e "s|image: wardby-runtime|image: ${RUNTIME_IMAGE}|" \
        -e "s|value: wardby-coding-worker-image-node-python-3-12$|value: ${WORKER_IMAGE_NODE_PYTHON}|" \
        -e "s|value: wardby-coding-worker-image$|value: ${WORKER_IMAGE}|" \
        -e "s|value: wardby-apiserver-host|value: ${API_HOST}|" \
        -e "s|wardby-control-plane-hostname|${HOSTNAME}|g" \
        -e "s|cidr: wardby-database-cidr|cidr: ${DB_IP}/32|g" \
  | iam_substitutions)"
assert_no_placeholders "$OVERLAY_MANIFEST"
echo "$OVERLAY_MANIFEST" | kubectl apply -f - >/dev/null

echo "==> 10/${TOTAL_STEPS} wait for rollouts"
kubectl -n "$NAMESPACE" rollout status deploy/wardby-coding-proxy --timeout=300s
kubectl -n "$NAMESPACE" rollout status deploy/wardby-control-plane --timeout=600s

echo "==> 11/${TOTAL_STEPS} prove the new pods can use the database"
# A Ready pod has not necessarily touched the database: the control plane and
# the coding proxy each run one query through their own Prisma client, Auth
# Proxy sidecar and database role. The query runs in the container itself
# (runtime image, WORKDIR /app, where require finds @prisma/client), with the
# pod's own DATABASE_URL, which is never printed: only "... reads the
# database" or the error message, with any connection URL in it masked.
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
  script='const { PrismaClient } = require("@prisma/client");
const mask = (m) => String(m).replace(/postgres(ql)?:\/\/[^\s\x60\x27"]+/gi, "<database url>");
setTimeout(() => { console.error("no answer from the database in 30s"); process.exit(1); }, 30000);
new PrismaClient().$queryRawUnsafe(`SELECT 1 FROM "'"$table"'" LIMIT 1`).then(
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
if ! $DATABASE_OK; then
  cat >&2 <<EOF
up.sh: the new pods cannot use the database.
  kubectl -n ${NAMESPACE} rollout undo deploy/wardby-control-plane
  kubectl -n ${NAMESPACE} rollout undo deploy/wardby-coding-proxy
restores the previous images and pod templates (any revision since the IAM
cutover), which also log in through IAM -- there is no password login to
restore.
"permission denied" means the grants are missing or incomplete. On a fresh
install the coding proxy's are expected to be missing until the bootstrap runs
again after the first migrations: run deploy/gke/bootstrap-database-iam.sh
(default mode), then up.sh again (docs/getting-started-gke.md, "Database
login"). --password-from-stdin is only for a deployment still on password
login.
EOF
  exit 1
fi

echo "==> 12/${TOTAL_STEPS} verify the public endpoint"
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
expect_status 200 "https://${HOSTNAME}/.well-known/oauth-protected-resource"
for i in $(seq 1 12); do
  got="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "https://${HOSTNAME}/.well-known/oauth-protected-resource" 2>/dev/null || true)"
  if [[ "$got" != "200" ]]; then
    echo "up.sh: discovery answered ${got:-no response} ${i} checks after it first answered 200; the endpoint is not stable." >&2
    exit 1
  fi
  sleep 5
done
echo "    discovery answers 200, steadily for a minute"
expect_status 401 -X POST "https://${HOSTNAME}/mcp" -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' -d "$MCP_INIT"
echo "    unauthenticated MCP is refused with 401"

cat <<EOF

Done. The control plane is running in ${CLUSTER}.

  MCP endpoint : https://${HOSTNAME}/mcp
  database     : ${DB_IP} (private IP, reached only through the Auth Proxy)
  images       : ${REGISTRY}
  secrets      : Secret Manager, prefix ${SECRET_PREFIX} (synced by External Secrets)

Still manual, because neither belongs in a script:

  * The Gateway needs a DNS A record for ${HOSTNAME} pointing at the reserved
    address, and a Google-managed certificate. Use DNS authorization rather than
    load-balancer authorization -- the latter needs the hostname to already
    resolve, which it will not before the endpoint exists.
  * A login key: self-hosted auth has no signup over HTTP, so mint one with
      kubectl exec -n ${NAMESPACE} deploy/wardby-control-plane -c control-plane -- \\
        node dist/cli.js auth user create --subject <you>
    It is printed once and is a bearer credential valid for a year.

Roll back (images are pinned by digest, so this is exactly what ran before):
  kubectl -n ${NAMESPACE} rollout undo deploy/wardby-control-plane
  kubectl -n ${NAMESPACE} rollout undo deploy/wardby-coding-proxy
Images before this deploy:
${PREVIOUS_IMAGES:-  (none: first deploy)}
Migrations only go forward, so a rollback is safe only while the schema change it
rolls back over was additive. See docs/getting-started-gke.md, "Roll back".
rollout undo reverts only the Deployments' images and pod templates -- there is
no password path to fall back to any more. It does not touch any NetworkPolicy:
a change to the database egress rules themselves is not undone by rollout undo.
EOF
