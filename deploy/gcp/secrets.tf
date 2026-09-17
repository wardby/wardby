resource "google_secret_manager_secret" "db_url" {
  project   = var.project_id
  secret_id = "${var.name_prefix}-database-url"

  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "db_url" {
  secret = google_secret_manager_secret.db_url.id
  # Unix-socket form: matches how Cloud Run's built-in Cloud SQL volume
  # mount exposes the instance, at /cloudsql/<connection_name> (cloud-run.tf).
  secret_data = "postgresql://${google_sql_user.app.name}:${random_password.db_password.result}@localhost/${google_sql_database.app.name}?host=/cloudsql/${google_sql_database_instance.main.connection_name}"
}

resource "google_secret_manager_secret_iam_member" "db_url_access" {
  project   = var.project_id
  secret_id = google_secret_manager_secret.db_url.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.cloud_run.email}"
}
