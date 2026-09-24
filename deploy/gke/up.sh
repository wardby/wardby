#!/usr/bin/env bash
#
# Stands up a wardby control plane on GKE Autopilot, from Terraform through to a
# serving MCP endpoint.
#
#   HOSTNAME=app.example.com deploy/gke/up.sh
#
# Idempotent: safe to re-run. Terraform converges, images are rebuilt and
# re-pushed (digests change only if the source did), secrets are replaced, and
# the overlay is re-applied.
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
TOTAL_STEPS=9

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
for img in runtime migration coding-worker; do docker push "${REGISTRY}/${img}:latest" >/dev/null; done

# Digests, not tags. The launcher refuses a tag, and a digest is the only
# reference that still means the same bytes tomorrow.
digest_of() { docker inspect --format '{{index .RepoDigests 0}}' "${REGISTRY}/$1:latest"; }
RUNTIME_IMAGE="$(digest_of runtime)"
MIGRATION_IMAGE="$(digest_of migration)"
WORKER_IMAGE="$(digest_of coding-worker)"

echo "==> 4/${TOTAL_STEPS} verify the worker image has tar, head and test"
# Seeding and collection shell out to these. Without them every launch hangs
# until its deadline, with nothing naming the cause.
if ! docker run --rm --platform linux/amd64 --entrypoint sh "$WORKER_IMAGE" -c 'command -v tar && command -v head && command -v test' >/dev/null; then
  echo "up.sh: worker image is missing tar, head or test." >&2
  exit 1
fi

echo "==> 5/${TOTAL_STEPS} seed Secret Manager"
# Fills only empty secrets: from the live cluster (so existing keys carry over),
# then .env.local, then -- for the two auth keys only -- a new random key. Values
# go over stdin and are never printed. Stops before writing anything if a value
# has no source.
node deploy/gke/seed-secrets.mjs --project "$PROJECT_ID" --prefix "$SECRET_PREFIX" \
  --context "$KUBE_CONTEXT" --namespace "$NAMESPACE" --tf-dir "$TF_DIR"

echo "==> 6/${TOTAL_STEPS} External Secrets Operator ${ESO_CHART_VERSION}, scoped to ${NAMESPACE}"
helm upgrade --install external-secrets external-secrets --repo "$ESO_CHART_REPO" \
  --version "$ESO_CHART_VERSION" --kube-context "$KUBE_CONTEXT" \
  --namespace external-secrets --create-namespace \
  --values deploy/gke/eso-values.yaml --wait --timeout 10m >/dev/null

echo "==> 7/${TOTAL_STEPS} sync the Secrets from Secret Manager"
kubectl apply -f deploy/kind-coding/manifests/base/namespace.yaml >/dev/null
kubectl kustomize deploy/kind-coding/manifests/overlays/gke-autopilot/secrets \
  | sed -e "s|wardby-gcp-project|${PROJECT_ID}|g" \
        -e "s|wardby-cluster-location|${REGION}|g" \
        -e "s|wardby-cluster-name|${CLUSTER}|g" \
        -e "s|wardby-secret-prefix|${SECRET_PREFIX}|g" \
  | kubectl apply -f - >/dev/null
# Safe only because step 5 succeeded: every value is already in Secret Manager.
NAMESPACE="$NAMESPACE" release_unowned_secrets wardby-coding-proxy-env wardby-control-plane-env
if ! NAMESPACE="$NAMESPACE" wait_external_secrets_ready 180s wardby-coding-proxy-env wardby-control-plane-env; then
  echo "up.sh: the Secrets did not sync from Secret Manager; nothing else was applied." >&2
  exit 1
fi

echo "==> 8/${TOTAL_STEPS} render and apply the overlay"
# Every value below is target identity: it is substituted here and never
# committed. The placeholders are the contract between this script and the
# tracked manifests.
kubectl kustomize "$OVERLAY" \
  | sed -e "s|image: wardby-runtime|image: ${RUNTIME_IMAGE}|" \
        -e "s|image: wardby-migration|image: ${MIGRATION_IMAGE}|" \
        -e "s|value: wardby-coding-worker-image|value: ${WORKER_IMAGE}|" \
        -e "s|value: wardby-apiserver-host|value: ${API_HOST}|" \
        -e "s|wardby-control-plane-hostname|${HOSTNAME}|g" \
        -e "s|cidr: wardby-database-cidr|cidr: ${DB_IP}/32|g" \
  | kubectl apply -f - >/dev/null

echo "==> 9/${TOTAL_STEPS} wait for rollouts"
kubectl -n "$NAMESPACE" rollout status deploy/wardby-coding-proxy --timeout=300s
kubectl -n "$NAMESPACE" rollout status deploy/wardby-control-plane --timeout=600s

cat <<EOF

Done. The control plane is running in ${CLUSTER}.

  MCP endpoint : https://${HOSTNAME}/mcp
  database     : ${DB_IP}:5432 (private IP, no public address)
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

Verify:
  curl -sS -o /dev/null -w '%{http_code}\\n' https://${HOSTNAME}/.well-known/oauth-protected-resource   # 200
  curl -sS -o /dev/null -w '%{http_code}\\n' -X POST https://${HOSTNAME}/mcp                            # 401
EOF
