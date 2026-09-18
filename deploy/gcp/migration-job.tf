# One-time-per-image Prisma migration run against the live database, via
# the Dockerfile's `migration` build target (deploy/Dockerfile:12-13) -
# neither the runtime image nor anything else in this module ran
# migrations before this resource existed. Found the hard way: a fresh
# apply against onit-dashboard left every Prisma table missing
# (2026-09-18) until migrations were run by hand through a Cloud SQL
# proxy tunnel. See docs/superpowers/plans/2026-09-18-gcp-production-readiness.md.
resource "google_cloud_run_v2_job" "migrate" {
  name     = "${var.name_prefix}-migrate"
  project  = var.project_id
  location = var.region

  template {
    template {
      service_account = google_service_account.cloud_run.email
      max_retries     = 0
      timeout         = "300s"

      volumes {
        name = "cloudsql"
        cloud_sql_instance {
          instances = [google_sql_database_instance.main.connection_name]
        }
      }

      containers {
        image = var.migration_image

        volume_mounts {
          name       = "cloudsql"
          mount_path = "/cloudsql"
        }

        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.db_url.secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_iam_member.db_url_access,
    google_secret_manager_secret_version.db_url,
  ]
}

# Runs the job automatically on every apply where the migration image
# changes - a plain `terraform apply` should never again leave the schema
# stale. Re-running against an unchanged image is a safe no-op: Prisma's
# `migrate deploy` skips already-applied migrations. Requires the
# identity running `terraform apply` to have `roles/run.developer` (or
# broader, e.g. `roles/run.admin` - see SETUP.md step 6) and the `gcloud`
# CLI available on PATH wherever `terraform apply` runs.
resource "null_resource" "run_migration" {
  triggers = {
    image = var.migration_image
  }

  provisioner "local-exec" {
    command = "gcloud run jobs execute ${google_cloud_run_v2_job.migrate.name} --project=${var.project_id} --region=${var.region} --wait"
  }

  depends_on = [google_cloud_run_v2_job.migrate]
}
