#!/usr/bin/env bash
# TEST ONLY: a throwaway CA and server certificate for wardby-sim (deploy/kind-coding/sim.yaml),
# so the simulator speaks https and Jira's https-only rule stays on. Generate one per kind
# cluster; never reuse it, never commit its output, and never apply it to a real cluster.
#
#   bash deploy/kind-coding/sim-ca.sh <out-dir>            # writes ca.crt, tls.crt, tls.key
#   bash deploy/kind-coding/sim-ca.sh <out-dir> --apply    # also creates the Kubernetes objects
#
# --apply (kind-* contexts only) creates:
#   - Secret wardby-sim/wardby-sim-tls (the server certificate and key, for the simulator);
#   - ConfigMap wardby-coding/wardby-sim-ca (the CA certificate only), which test pods mount
#     and point NODE_EXTRA_CA_CERTS at. A pod without it cannot reach the simulator over TLS.
# The CA's private key stays in <out-dir>; it is only needed to sign this one certificate.
set -euo pipefail

OUT="${1:-}"
APPLY="${2:-}"
if [[ -z "$OUT" ]]; then
  echo "usage: sim-ca.sh <out-dir> [--apply]" >&2
  exit 2
fi
command -v openssl >/dev/null 2>&1 || { echo "sim-ca.sh: openssl is required." >&2; exit 1; }
mkdir -p "$OUT"
umask 077

openssl req -x509 -newkey rsa:2048 -nodes -days 7 \
  -subj "/CN=wardby-sim throwaway test CA" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout "$OUT/ca.key" -out "$OUT/ca.crt" 2>/dev/null

cat >"$OUT/server.ext" <<'EXT'
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:wardby-sim,DNS:wardby-sim.wardby-sim,DNS:wardby-sim.wardby-sim.svc,DNS:wardby-sim.wardby-sim.svc.cluster.local,DNS:localhost,IP:127.0.0.1
EXT
openssl req -newkey rsa:2048 -nodes -subj "/CN=wardby-sim.wardby-sim.svc" \
  -keyout "$OUT/tls.key" -out "$OUT/tls.csr" 2>/dev/null
openssl x509 -req -in "$OUT/tls.csr" -CA "$OUT/ca.crt" -CAkey "$OUT/ca.key" -CAcreateserial \
  -days 7 -extfile "$OUT/server.ext" -out "$OUT/tls.crt" 2>/dev/null
rm -f "$OUT/tls.csr" "$OUT/server.ext" "$OUT/ca.srl"
chmod 644 "$OUT/ca.crt" "$OUT/tls.crt"
echo "sim-ca.sh: wrote $OUT/ca.crt, $OUT/tls.crt, $OUT/tls.key (TEST ONLY, valid 7 days)."

if [[ "$APPLY" == "--apply" ]]; then
  CONTEXT="${KUBE_CONTEXT:-$(kubectl config current-context)}"
  if [[ "$CONTEXT" != kind-* ]]; then
    echo "sim-ca.sh: refusing to apply to context '$CONTEXT': kind clusters only." >&2
    exit 1
  fi
  kubectl --context "$CONTEXT" create secret tls wardby-sim-tls -n wardby-sim --cert="$OUT/tls.crt" --key="$OUT/tls.key" \
    --dry-run=client -o yaml | kubectl --context "$CONTEXT" apply -f -
  kubectl --context "$CONTEXT" create configmap wardby-sim-ca -n wardby-coding --from-file=ca.crt="$OUT/ca.crt" \
    --dry-run=client -o yaml | kubectl --context "$CONTEXT" apply -f -
fi
