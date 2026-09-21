resource "google_cloud_run_domain_mapping" "main" {
  count = var.create_domain_mapping ? 1 : 0

  name     = var.domain_name
  project  = var.project_id
  location = var.region

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_v2_service.main.name
  }
}
