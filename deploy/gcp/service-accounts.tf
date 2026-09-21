# Custom, least-privilege identity for the Cloud Run service - deliberately
# not the broad-scope default compute service account, to bound the blast
# radius of any future SSRF-class bug to exactly what wardby needs.
resource "google_service_account" "cloud_run" {
  project      = var.project_id
  account_id   = "${var.name_prefix}-run"
  display_name = "${var.name_prefix} Cloud Run service"
}

resource "google_project_iam_member" "cloud_run_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.cloud_run.email}"
}
