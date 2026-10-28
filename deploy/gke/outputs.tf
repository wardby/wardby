output "private_ip_address" {
  description = "The instance's private address. Reachable only from inside the peered VPC."
  value       = google_sql_database_instance.main.private_ip_address
}

output "instance_name" {
  description = "Cloud SQL instance name, for gcloud commands and the console."
  value       = google_sql_database_instance.main.name
}

output "database_name" {
  value = google_sql_database.app.name
}

output "database_user" {
  value = var.database_user
}

output "cluster_name" {
  value = google_container_cluster.runs.name
}

output "cluster_endpoint" {
  description = "API server endpoint. Note this is what the in-cluster control plane must be pointed at via KUBERNETES_SERVICE_HOST: on Dataplane V2 the kubernetes.default ClusterIP is unreachable through any NetworkPolicy ipBlock rule."
  value       = google_container_cluster.runs.endpoint
}

output "artifact_registry_url" {
  description = "Registry prefix for image references, e.g. <url>/coding-worker@sha256:..."
  value       = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

output "kubectl_context_command" {
  description = "Fetches credentials and creates the kubectl context the launcher config names."
  value       = "gcloud container clusters get-credentials ${google_container_cluster.runs.name} --region ${var.region} --project ${var.project_id}"
}

output "project_id" {
  value = var.project_id
}

output "region" {
  value = var.region
}

output "secret_name_prefix" {
  description = "Prefix of the Secret Manager secret names; up.sh passes it to seed-secrets.mjs and the SecretStore manifests."
  value       = var.name_prefix
}

output "instance_connection_name" {
  description = "project:region:instance, for the Cloud SQL Auth Proxy."
  value       = google_sql_database_instance.main.connection_name
}

output "app_service_account" {
  value = google_service_account.database["app"].email
}

output "migrator_service_account" {
  value = google_service_account.database["migrator"].email
}

output "proxy_service_account" {
  value = google_service_account.database["proxy"].email
}

output "app_database_user" {
  value = google_sql_user.iam["app"].name
}

output "migrator_database_user" {
  value = google_sql_user.iam["migrator"].name
}

output "proxy_database_user" {
  value = google_sql_user.iam["proxy"].name
}

output "gateway_service_account" {
  value = google_service_account.database["gateway"].email
}

output "gateway_database_user" {
  value = google_sql_user.iam["gateway"].name
}

output "dependency_cache_bucket" {
  description = "Name of the run dependency cache bucket; empty when dependency_cache_enabled is false."
  value       = try(google_storage_bucket.dependency_cache[0].name, "")
}

output "session_transcripts_bucket" {
  description = "Name of the session transcripts bucket; empty when session_transcripts_enabled is false."
  value       = try(google_storage_bucket.session_transcripts[0].name, "")
}

output "session_transcripts_retention_days" {
  description = "Days the session transcripts bucket keeps a transcript; deploy/gke/up.sh passes it to the control plane as RUN_TRANSCRIPT_RETENTION_DAYS."
  value       = var.session_transcripts_retention_days
}
