{{/* The control plane's chart-derived environment, as a map; controlPlane.env overrides it. */}}
{{- define "wardby.controlPlane.env" -}}
{{- $cp := .Values.controlPlane -}}
{{- $runs := .Values.codingRuns -}}
{{- $sb := .Values.nativeSandbox -}}
{{- $env := dict
  "MCP_TRANSPORT" "http"
  "MCP_HTTP_BIND" (printf "0.0.0.0:%d" (int $cp.port))
  "MCP_CANONICAL_URI" (include "wardby.canonicalUri" .)
  "AUTH_AUDIENCE" (include "wardby.canonicalUri" .)
  "EXECUTOR" "dbos"
  "DBOS__APPVERSION" (default (default .Chart.AppVersion .Values.image.runtime.tag) .Values.image.runtime.digest)
  "JOB_LAUNCHER" "kubernetes"
  "KUBERNETES_NAMESPACE" .Release.Namespace
  "KUBERNETES_PROXY_SERVICE" "wardby-coding-proxy"
  "KUBERNETES_PLATFORM" $runs.platform
  "KUBERNETES_RUN_PRIORITY_CLASS" "wardby-coding-run"
  "KUBERNETES_RESOURCE_QUOTA" "wardby-coding"
  "KUBERNETES_PREFLIGHT_TIMEOUT_MS" $runs.preflightTimeoutMs
  "KUBERNETES_READY_TIMEOUT_MS" $runs.readyTimeoutMs
  "CODING_MAX_CONCURRENT" $runs.maxConcurrent
  "NATIVE_SANDBOX_LAUNCHER" "kubernetes"
  "NATIVE_SANDBOX_WORKER_IMAGE" (required "image.nativeWorker.repository is required: the native gateway serves sandbox workers" (include "wardby.runImage" (list $ "nativeWorker")))
  "NATIVE_SANDBOX_CPUS" $sb.cpus
  "NATIVE_SANDBOX_MEMORY_MB" $sb.memoryMb
  "NATIVE_SANDBOX_MAX_CONCURRENT" $sb.maxConcurrent
  "NATIVE_SANDBOX_WARM_POOL_SIZE" $sb.warmPoolSize
  "NATIVE_SANDBOX_READY_TIMEOUT_MS" $sb.readyTimeoutMs
  "NATIVE_SANDBOX_ENFORCEMENT_TIMEOUT_MS" $sb.enforcementTimeoutMs
-}}
{{- $optional := dict
  "CODING_WORKER_IMAGE" (include "wardby.runImage" (list $ "codingWorker"))
  "CODING_WORKER_IMAGE_NODE_PYTHON_3_12" (include "wardby.runImage" (list $ "codingWorkerNodePython"))
  "CODING_WORKER_IMAGE_NODE_PYTHON_3_13" (include "wardby.runImage" (list $ "codingWorkerNodePython313"))
  "CODING_WORKER_IMAGE_NODE_PYTHON_3_14" (include "wardby.runImage" (list $ "codingWorkerNodePython314"))
  "CODING_CLAUDE_WORKER_IMAGE" (include "wardby.runImage" (list $ "claudeCodingWorker"))
  "CODING_CLAUDE_TOOL_RUNNER_IMAGE" (include "wardby.runImage" (list $ "claudeToolRunner"))
  "CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12" (include "wardby.runImage" (list $ "claudeToolRunnerNodePython"))
  "CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_13" (include "wardby.runImage" (list $ "claudeToolRunnerNodePython313"))
  "CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_14" (include "wardby.runImage" (list $ "claudeToolRunnerNodePython314"))
  "CODING_CPUS" $runs.cpus
  "CODING_MEMORY_MB" $runs.memoryMb
  "CODING_DISK_MB" $runs.diskMb
  "CODING_MAX_DISK_MB" $runs.maxDiskMb
  "CODING_PIDS" $runs.pids
  "NATIVE_SANDBOX_PIDS" $sb.pids
  "NATIVE_SANDBOX_WARM_MAX_AGE_MS" $sb.warmMaxAgeMs
  "KUBERNETES_RUNTIME_CLASS" $runs.runtimeClass
  "KUBERNETES_SERVICE_HOST" $cp.kubernetesApi.host
  "KUBERNETES_SERVICE_PORT" (ternary $cp.kubernetesApi.port "" (not (empty $cp.kubernetesApi.host)))
  "WARDBY_MODEL_CATALOG_REFRESH_SECONDS" .Values.models.catalogRefreshSeconds
  "VERTEX_PROJECT" .Values.models.vertexProject
  "AUTH_PROVIDER" $cp.auth.provider
  "AUTH_ISSUER" $cp.auth.issuer
  "AUTH_JWKS_URI" $cp.auth.jwksUri
  "AUTH_ROLE_CLAIM" $cp.auth.roleClaim
  "AUTH_ROLE_MAP" $cp.auth.roleMap
-}}
{{- range $k, $v := $optional }}
{{- if not (empty $v) }}
{{- $_ := set $env $k $v }}
{{- end }}
{{- end }}
{{- /* The launcher tells each run where the proxy's CONNECT tunnel is; the proxy's own settings are in
wardby.codingProxy.env, from the same codingProxy.tunnel values. The hosts are validated here, not used. */ -}}
{{- with .Values.codingProxy.tunnel }}
{{- if .enabled }}
{{- include "wardby.codingProxy.tunnelAgentHosts" $ }}
{{- $_ := set $env "CODING_TUNNEL_PORT" (int .port | toString) }}
{{- if .allowedHosts }}
{{- $_ := set $env "CODING_TUNNEL_ALLOWED_HOSTS" (join "," .allowedHosts) }}
{{- end }}
{{- /* The ceiling on per-agent hosts is checked when an agent is saved and when a run is dispatched. */ -}}
{{- if ne (toString (default "off" .agentHosts)) "off" }}
{{- $_ := set $env "CODING_TUNNEL_AGENT_HOSTS" (toString .agentHosts) }}
{{- end }}
{{- /* To have runs trust the interception CA, give the control plane the public certificate alone: from
the CA Secret (mounted in control_plane.yaml), or as CODING_TUNNEL_TRUST_CA_CERT (controlPlane.extraEnv).
The key is the proxy's and never goes here. */ -}}
{{- if include "wardby.codingProxy.interceptCaSecret" $ }}
{{- $_ := set $env "CODING_TUNNEL_TRUST_CA_CERT_FILE" "/etc/wardby/tunnel-trust-ca/ca.crt" }}
{{- end }}
{{- end }}
{{- end }}
{{- if $cp.metrics.enabled }}
{{- $_ := set $env "METRICS_BIND" (printf "0.0.0.0:%d" (int $cp.metrics.port)) }}
{{- $_ := set $env "METRICS_ALLOW_NON_LOOPBACK" "true" }}
{{- end }}
{{- toYaml $env }}
{{- end -}}
