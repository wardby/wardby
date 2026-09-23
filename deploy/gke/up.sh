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

TF_DIR="deploy/gke"
OVERLAY="deploy/kind-coding/manifests/overlays/gke-autopilot"
NAMESPACE="wardby-coding"
TOTAL_STEPS=8

: "${HOSTNAME:?set HOSTNAME to the hostname the MCP endpoint is published on (e.g. app.example.com)}"

# Reads one key out of .env.local through the project's own dotenv loader.
#
# NOT a grep: GITHUB_APP_PRIVATE_KEY is a quoted, genuinely multi-line PEM, and a
# line-oriented extractor captures its BEGIN header and nothing else. That
# produced a Secret the server accepted at startup and rejected on the first
# coding run. Only the key's NAME is ever passed on a command line; the value
# goes straight from node's stdout into a shell variable.
env_b64() {
  node -e '
    const name = process.argv[1];
    require("dotenv-flow").config({ silent: true });
    const value = process.env[name];
    if (!value) { console.error(`up.sh: ${name} must be set in .env.local.`); process.exit(1); }
    process.stdout.write(Buffer.from(value, "utf8").toString("base64"));
  ' "$1"
}

b64() { printf '%s' "$1" | base64 | tr -d '\n'; }

echo "==> 1/${TOTAL_STEPS} terraform: cluster, image registry, database"
terraform -chdir="$TF_DIR" init -input=false >/dev/null
terraform -chdir="$TF_DIR" apply -input=false -auto-approve

PROJECT_ID="$(terraform -chdir="$TF_DIR" output -raw project_id 2>/dev/null || grep -E '^\s*project_id' "$TF_DIR/terraform.tfvars" | head -1 | sed 's/.*=\s*"//; s/"//')"
REGION="$(terraform -chdir="$TF_DIR" output -raw region 2>/dev/null || echo us-central1)"
CLUSTER="$(terraform -chdir="$TF_DIR" output -raw cluster_name)"
REGISTRY="$(terraform -chdir="$TF_DIR" output -raw artifact_registry_url)"
DB_IP="$(terraform -chdir="$TF_DIR" output -raw private_ip_address)"

echo "==> 2/${TOTAL_STEPS} kubectl context for ${CLUSTER}"
gcloud container clusters get-credentials "$CLUSTER" --region "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1
KUBE_CONTEXT="gke_${PROJECT_ID}_${REGION}_${CLUSTER}"
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

echo "==> 5/${TOTAL_STEPS} namespace and the proxy's env Secret"
kubectl apply -f deploy/kind-coding/manifests/base/namespace.yaml >/dev/null

# Assembled with printf and piped into `kubectl apply`, never --from-literal:
# an argument is visible in argv for the life of the process.
DB_URL_B64="$(b64 "$(terraform -chdir="$TF_DIR" output -raw database_url)")"
OPENAI_B64="$(env_b64 OPENAI_API_KEY)"
ANTHROPIC_B64="$(env_b64 ANTHROPIC_API_KEY)"
{
  printf 'apiVersion: v1\nkind: Secret\ntype: Opaque\nmetadata:\n'
  printf '  name: wardby-coding-proxy-env\n  namespace: %s\ndata:\n' "$NAMESPACE"
  printf '  DATABASE_URL: %s\n' "$DB_URL_B64"
  printf '  OPENAI_API_KEY: %s\n' "$OPENAI_B64"
  printf '  ANTHROPIC_API_KEY: %s\n' "$ANTHROPIC_B64"
} | kubectl apply -f - >/dev/null
unset DB_URL_B64 OPENAI_B64 ANTHROPIC_B64

echo "==> 6/${TOTAL_STEPS} the control plane's env Secret"
# Reuses the committed script, which reads the database URL back out of the
# proxy Secret written above and preserves any OAuth signing keys already issued.
KUBE_CONTEXT="$KUBE_CONTEXT" NAMESPACE="$NAMESPACE" deploy/kind-coding/control-plane-secret.sh

echo "==> 7/${TOTAL_STEPS} render and apply the overlay"
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

echo "==> 8/${TOTAL_STEPS} wait for rollouts"
kubectl -n "$NAMESPACE" rollout status deploy/wardby-coding-proxy --timeout=300s
kubectl -n "$NAMESPACE" rollout status deploy/wardby-control-plane --timeout=600s

cat <<EOF

Done. The control plane is running in ${CLUSTER}.

  MCP endpoint : https://${HOSTNAME}/mcp
  database     : ${DB_IP}:5432 (private IP, no public address)
  images       : ${REGISTRY}

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
