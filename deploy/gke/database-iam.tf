# Password-less database access. Each workload authenticates to Cloud SQL as its
# own Google service account, through the Cloud SQL Auth Proxy, via Workload
# Identity from one Kubernetes service account. What each may do inside the
# database is decided by deploy/gke/database-grants.sql, applied once by
# deploy/gke/bootstrap-database-iam.sh.

locals {
  database_identities = {
    app      = "wardby-control-plane"
    migrator = "wardby-migrator"
    proxy    = "wardby-coding-proxy"
  }
}

resource "google_service_account" "database" {
  for_each = local.database_identities

  project      = var.project_id
  account_id   = "${var.name_prefix}-${each.key}"
  display_name = "wardby ${each.key} (Cloud SQL IAM login)"
}

resource "google_project_iam_member" "database_client" {
  for_each = local.database_identities

  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.database[each.key].email}"
}

resource "google_project_iam_member" "database_instance_user" {
  for_each = local.database_identities

  project = var.project_id
  role    = "roles/cloudsql.instanceUser"
  member  = "serviceAccount:${google_service_account.database[each.key].email}"
}

resource "google_service_account_iam_member" "database_workload_identity" {
  for_each = local.database_identities

  service_account_id = google_service_account.database[each.key].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[wardby-coding/${each.value}]"
}

resource "google_sql_user" "iam" {
  for_each = local.database_identities

  project  = var.project_id
  instance = google_sql_database_instance.main.name
  # Cloud SQL names an IAM service-account user by its email without the
  # ".gserviceaccount.com" suffix.
  name = trimsuffix(google_service_account.database[each.key].email, ".gserviceaccount.com")
  type = "CLOUD_IAM_SERVICE_ACCOUNT"

  # Same reason the built-in owner is handled with a `removed` block in
  # cloudsql.tf: once a user has been granted privileges, Postgres refuses to
  # drop it, and destroy would fail halfway.
  deletion_policy = "ABANDON"
}
