import type { V1Secret } from "@kubernetes/client-node";

/** The egress gateway's reference to one key of a per-run Secret. */
export function credentialUri(namespace: string, secretName: string, key: string): string {
  return `ate-secret://k8s.io/default/${namespace}/${secretName}/${key}`;
}

/** The only shape a per-run Secret takes. Never log or serialize the result. */
export function substrateSecret(o: {
  name: string;
  namespace: string;
  label: { key: string; value: string };
  data: Record<string, string>;
}): V1Secret {
  return {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: o.name, namespace: o.namespace, labels: { [o.label.key]: o.label.value } },
    stringData: o.data,
  };
}
