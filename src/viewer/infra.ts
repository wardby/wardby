/** The read model behind GET /admin/api/infra (docs/viewer-api.md): built once at startup, no cluster reads. */
import { loadKubernetesJobConfig, loadNativeSandboxConfig, loadProviderConfig } from "../config/providers.js";
import {
  NATIVE_RUN_COMPONENT_LABEL,
  NATIVE_RUN_SHA_LABEL,
  NATIVE_WARM_POOL_LABEL,
  NATIVE_WARM_TOKEN_LABEL,
} from "../native-worker/kubernetes-isolation.js";
import {
  RUN_COMPONENT_LABEL,
  RUN_MANAGED_BY_LABEL,
  RUN_SHA_CHARS,
  RUN_SHA_LABEL,
} from "../providers/jobs/kubernetes-isolation.js";
import type { InfraInfo } from "./api-schema.js";

export function buildInfraInfo(env: NodeJS.ProcessEnv = process.env): InfraInfo {
  const raw = loadProviderConfig(env).jobs;
  const launcher = raw === "docker" || raw === "kubernetes" ? raw : "local";
  const native = buildNativeInfo(env);
  if (launcher !== "kubernetes") return { launcher, kubernetes: null, native };
  const k8s = loadKubernetesJobConfig(env);
  return {
    launcher,
    native,
    kubernetes: {
      namespace: k8s.namespace,
      platform: k8s.platform,
      runtimeClass: k8s.runtimeClassName ?? null,
      proxyService: k8s.proxyService,
      runLabel: RUN_SHA_LABEL,
      runLabelHashChars: RUN_SHA_CHARS,
      componentLabel: { ...RUN_COMPONENT_LABEL },
      managedByLabel: { ...RUN_MANAGED_BY_LABEL },
    },
  };
}

/** Where sandbox-mode native agents run (NATIVE_SANDBOX_*); null when no sandbox launcher is configured. */
function buildNativeInfo(env: NodeJS.ProcessEnv): InfraInfo["native"] {
  const config = loadNativeSandboxConfig(env);
  if (!config) return null;
  return {
    launcher: config.launcher,
    warmPoolSize: config.warmPoolSize,
    kubernetes:
      config.launcher === "kubernetes"
        ? {
            namespace: config.namespace,
            runtimeClass: config.runtimeClassName ?? null,
            runLabel: NATIVE_RUN_SHA_LABEL,
            componentLabel: { ...NATIVE_RUN_COMPONENT_LABEL },
            warmPoolLabel: { ...NATIVE_WARM_POOL_LABEL },
            warmWorkerLabel: NATIVE_WARM_TOKEN_LABEL,
          }
        : null,
  };
}
