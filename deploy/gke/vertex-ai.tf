# Vertex AI Gemini for native agents (docs/models.md). Model calls run in the
# control plane and the native gateway, which authenticate as their own Google
# service accounts through Workload Identity: no key is stored.
resource "google_project_service" "aiplatform" {
  count   = var.vertex_ai_enabled ? 1 : 0
  project = var.project_id
  service = "aiplatform.googleapis.com"

  disable_on_destroy = false
}

resource "google_project_iam_member" "vertex_ai_user" {
  for_each = var.vertex_ai_enabled ? toset(["app", "gateway"]) : toset([])

  project = var.project_id
  role    = "roles/aiplatform.user"
  member  = "serviceAccount:${google_service_account.database[each.key].email}"
}
