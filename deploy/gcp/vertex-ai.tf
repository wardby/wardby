# Vertex AI Gemini for native agents (docs/models.md). Model calls run in the
# Cloud Run service, which authenticates as its own service account
# (service-accounts.tf): no key is stored.
resource "google_project_service" "aiplatform" {
  count   = var.vertex_ai_enabled ? 1 : 0
  project = var.project_id
  service = "aiplatform.googleapis.com"

  disable_on_destroy = false
}

resource "google_project_iam_member" "cloud_run_vertex_ai_user" {
  count   = var.vertex_ai_enabled ? 1 : 0
  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.cloud_run.email}"
}
