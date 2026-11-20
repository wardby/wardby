{{- define "wardby.labels" -}}
app.kubernetes.io/part-of: wardby
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{/* args: (list $ "<image key>") */}}
{{- define "wardby.image" -}}
{{- $ := index . 0 -}}
{{- $img := index $.Values.image (index . 1) -}}
{{- $ref := printf "%s/%s" $.Values.image.registry $img.repository -}}
{{- if $img.digest -}}
{{- printf "%s@%s" $ref $img.digest -}}
{{- else -}}
{{- printf "%s:%s" $ref (default $.Chart.AppVersion $img.tag) -}}
{{- end -}}
{{- end -}}

{{- define "wardby.canonicalUri" -}}
{{- printf "https://%s/mcp" (required "hostname is required" .Values.hostname) -}}
{{- end -}}

{{/* args: (list $ "<image key>"); a launched image, which the launcher runs only by digest. Empty when the repository is unset. */}}
{{- define "wardby.runImage" -}}
{{- $ := index . 0 -}}
{{- $key := index . 1 -}}
{{- $img := index $.Values.image $key -}}
{{- if $img.repository -}}
{{- $digest := required (printf "image.%s.digest is required: the launcher runs worker images only by digest (sha256:...). Set image.%s.repository to \"\" to leave it unconfigured" $key $key) $img.digest -}}
{{- printf "%s/%s@%s" $.Values.image.registry $img.repository $digest -}}
{{- end -}}
{{- end -}}

{{/* args: (list $ <workload values>) */}}
{{- define "wardby.podScheduling" -}}
{{- $ := index . 0 -}}
{{- $w := index . 1 -}}
{{- with $.Values.imagePullSecrets }}
imagePullSecrets:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $w.nodeSelector }}
nodeSelector:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $w.tolerations }}
tolerations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- with $w.topologySpreadConstraints }}
topologySpreadConstraints:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/*
A workload's PodDisruptionBudget, when its podDisruptionBudget is enabled.
Called with (list $ <workload values> <name>). A pod that is not ready may
always be evicted, so a crash-looping pod never holds up a node drain.
*/}}
{{- define "wardby.podDisruptionBudget" -}}
{{- $ := index . 0 -}}
{{- $w := index . 1 -}}
{{- $name := index . 2 -}}
{{- $pdb := $w.podDisruptionBudget -}}
{{- if $pdb.enabled }}
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ $name }}
  namespace: {{ $.Release.Namespace }}
  labels:
    {{- include "wardby.labels" $ | nindent 4 }}
spec:
  {{- if hasKey $pdb "minAvailable" }}
  minAvailable: {{ $pdb.minAvailable }}
  {{- else }}
  maxUnavailable: {{ $pdb.maxUnavailable }}
  {{- end }}
  unhealthyPodEvictionPolicy: AlwaysAllow
  selector:
    matchLabels:
      app.kubernetes.io/name: {{ $name }}
{{- end }}
{{- end -}}

{{/* args: (list $ <workload values>); the pod template's annotations block: podAnnotations, then the workload's over them. Empty when there are none. */}}
{{- define "wardby.podAnnotations" -}}
{{- $ := index . 0 -}}
{{- $w := index . 1 -}}
{{- with merge (deepCopy (default dict $w.podAnnotations)) (default dict $.Values.podAnnotations) }}
annotations:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/* args: (list $ <workload values> "<database.urls key>" <default env map>); the container's env list:
DATABASE_URL and NODE_ENV, the rest by name, then extraEnv; or in the workload's envOrder, when set. */}}
{{- define "wardby.env" -}}
{{- $ := index . 0 -}}
{{- $w := index . 1 -}}
{{- $url := index $.Values.database.urls (index . 2) -}}
{{- $vars := merge (deepCopy (default dict $w.env)) (index . 3) (dict "NODE_ENV" "production") -}}
{{- if $url }}
{{- $_ := set $vars "DATABASE_URL" $url -}}
{{- end }}
{{- $names := concat (list "DATABASE_URL" "NODE_ENV") (without (keys $vars | sortAlpha) "DATABASE_URL" "NODE_ENV") -}}
{{- $env := list -}}
{{- range $k := $names }}
{{- if hasKey $vars $k }}
{{- $v := index $vars $k -}}
{{- if and (kindIs "float64" $v) (eq $v (floor $v)) }}
{{- $v = int64 $v -}}
{{- end }}
{{- $env = append $env (dict "name" $k "value" (toString $v)) -}}
{{- end }}
{{- end }}
{{- $env = concat $env (default list $w.extraEnv) -}}
{{- with $w.envOrder }}
{{- $ordered := list -}}
{{- range $name := . }}
{{- range $env }}
{{- if eq .name $name }}
{{- $ordered = append $ordered . -}}
{{- end }}
{{- end }}
{{- end }}
{{- range $env }}
{{- if not (has .name $w.envOrder) }}
{{- $ordered = append $ordered . -}}
{{- end }}
{{- end }}
{{- $env = $ordered -}}
{{- end }}
{{- toYaml $env }}
{{- end -}}

{{/* args: (list $ <workload values>) */}}
{{- define "wardby.envFrom" -}}
{{- $ := index . 0 -}}
{{- $w := index . 1 -}}
{{- $from := list -}}
{{- if $w.envFromSecret }}
{{- $from = append $from (dict "secretRef" (dict "name" $w.envFromSecret)) -}}
{{- end }}
{{- if $.Values.models.providerSecret }}
{{- $from = append $from (dict "secretRef" (dict "name" $.Values.models.providerSecret)) -}}
{{- end }}
{{- with concat $from (default list $w.extraEnvFrom) }}
envFrom:
  {{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{- define "wardby.cloudSqlProxy" -}}
{{- $p := .Values.database.cloudSqlProxy -}}
{{- if $p.enabled }}
- name: cloud-sql-proxy
  image: {{ $p.image }}
  restartPolicy: Always
  args:
    {{- if $p.autoIamAuthn }}
    - --auto-iam-authn
    {{- end }}
    {{- if $p.privateIp }}
    - --private-ip
    {{- end }}
    - --address=127.0.0.1
    - --port={{ $p.port }}
    {{- if $p.structuredLogs }}
    - --structured-logs
    {{- end }}
    - --health-check
    - --http-address=0.0.0.0
    - --http-port={{ $p.healthPort }}
    {{- if $p.exitZeroOnSigterm }}
    - --exit-zero-on-sigterm
    {{- end }}
    {{- range $p.extraArgs }}
    - {{ . }}
    {{- end }}
    - {{ required "database.cloudSqlProxy.instanceConnectionName is required" $p.instanceConnectionName }}
  startupProbe:
    httpGet:
      path: /startup
      port: {{ $p.healthPort }}
    {{- toYaml $p.startupProbe | nindent 4 }}
  resources:
    {{- toYaml $p.resources | nindent 4 }}
  securityContext:
    {{- toYaml (merge (dict "runAsNonRoot" true) .Values.containerSecurityContext) | nindent 4 }}
{{- end }}
{{- end -}}

{{/* NetworkPolicy egress rules for DNS. */}}
{{/* NetworkPolicy egress rules for DNS: the DNS cache addresses, then NodeLocal DNSCache and kube-dns. */}}
{{- define "wardby.dnsEgress" -}}
{{- $ports := list (dict "port" 53 "protocol" "UDP") (dict "port" 53 "protocol" "TCP") -}}
{{- $rules := list -}}
{{- with .Values.networkPolicy.dns.cidrs }}
{{- $to := list -}}
{{- range . }}
{{- $to = append $to (dict "ipBlock" (dict "cidr" .)) -}}
{{- end }}
{{- $rules = append $rules (dict "ports" $ports "to" $to) -}}
{{- end }}
{{- $to := list -}}
{{- if .Values.networkPolicy.dns.nodeLocalDns }}
{{- $to = append $to (include "wardby.kubeSystemPod" "node-local-dns" | fromYaml) -}}
{{- end }}
{{- $to = append $to (include "wardby.kubeSystemPod" "kube-dns" | fromYaml) -}}
{{- toYaml (append $rules (dict "ports" $ports "to" $to)) }}
{{- end -}}

{{/* A NetworkPolicy peer: the kube-system pods with this k8s-app label. */}}
{{- define "wardby.kubeSystemPod" -}}
namespaceSelector:
  matchLabels:
    kubernetes.io/metadata.name: kube-system
podSelector:
  matchLabels:
    k8s-app: {{ . }}
{{- end -}}

{{/* NetworkPolicy egress rule for kube-dns only (the base policies of the proxy and gateway). */}}
{{- define "wardby.kubeDnsEgress" -}}
- ports:
    - port: 53
      protocol: UDP
    - port: 53
      protocol: TCP
  to:
    - {{- include "wardby.kubeSystemPod" "kube-dns" | nindent 6 }}
{{- end -}}

{{/* NetworkPolicy egress rules for the database (and the metadata server the Auth Proxy authenticates through). */}}
{{- define "wardby.databaseEgress" -}}
{{- $rules := list -}}
{{- with .Values.database.egress.cidrs }}
{{- $to := list -}}
{{- range . }}
{{- $to = append $to (dict "ipBlock" (dict "cidr" .)) -}}
{{- end }}
{{- $rules = append $rules (dict "ports" (list (dict "port" (int $.Values.database.egress.port) "protocol" "TCP")) "to" $to) -}}
{{- end }}
{{- if .Values.database.cloudSqlProxy.enabled }}
{{- $md := .Values.database.cloudSqlProxy.metadataServer -}}
{{- $ports := list -}}
{{- range $md.ports }}
{{- $ports = append $ports (dict "port" (int .) "protocol" "TCP") -}}
{{- end }}
{{- $to := list -}}
{{- range $md.cidrs }}
{{- $to = append $to (dict "ipBlock" (dict "cidr" .)) -}}
{{- end }}
{{- $rules = append $rules (dict "ports" $ports "to" $to) -}}
{{- end }}
{{- with $rules }}
{{- toYaml . }}
{{- end }}
{{- end -}}

{{/* NetworkPolicy egress rule for public HTTPS. */}}
{{- define "wardby.publicHttpsEgress" -}}
- ports:
    {{- range .Values.networkPolicy.publicEgressPorts }}
    - port: {{ . }}
      protocol: TCP
    {{- end }}
  to:
    - ipBlock:
        cidr: 0.0.0.0/0
        except:
          {{- toYaml .Values.networkPolicy.publicEgressExcept | nindent 10 }}
{{- end -}}

{{- define "wardby.tmpVolumeMount" -}}
- name: tmp
  mountPath: /tmp
{{- end -}}

{{/* args: <workload values>; the /tmp emptyDir volume. */}}
{{- define "wardby.tmpVolume" -}}
- name: tmp
  emptyDir:
    {{- toYaml .tmpVolume | nindent 4 }}
{{- end -}}

{{/* The coding proxy's chart-derived environment, as a map; codingProxy.env overrides it. */}}
{{- define "wardby.codingProxy.env" -}}
{{- $m := .Values.codingProxy.metrics -}}
{{- if $m.enabled }}
METRICS_BIND: {{ printf "0.0.0.0:%d" (int $m.port) | quote }}
METRICS_ALLOW_NON_LOOPBACK: "true"
{{- end }}
{{- end -}}
