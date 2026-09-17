output "cloud_run_service_url" {
  description = "The Cloud Run service's default *.run.app URL."
  value       = google_cloud_run_v2_service.main.uri
}

output "custom_domain" {
  description = "The custom domain mapped to the service - this is the stable MCP canonicalUri/AUTH_AUDIENCE."
  value       = var.domain_name
}

output "cloudsql_connection_name" {
  description = "Cloud SQL instance connection name, for gcloud/psql access outside the app."
  value       = google_sql_database_instance.main.connection_name
}
