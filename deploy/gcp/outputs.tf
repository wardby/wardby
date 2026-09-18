output "cloud_run_service_url" {
  description = "The Cloud Run service's default *.run.app URL."
  value       = google_cloud_run_v2_service.main.uri
}

output "custom_domain" {
  description = "The custom domain mapped to the service (null when create_domain_mapping is false - use cloud_run_service_url instead)."
  value       = var.create_domain_mapping ? var.domain_name : null
}

output "cloudsql_connection_name" {
  description = "Cloud SQL instance connection name, for gcloud/psql access outside the app."
  value       = google_sql_database_instance.main.connection_name
}
