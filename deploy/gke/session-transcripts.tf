# Session transcripts (sessionResume): a private bucket the control plane -- and
# nothing else -- can read and write. Off unless session_transcripts_enabled =
# true; with it off this file creates nothing and existing plans do not change.
#
# A transcript holds a coding run's whole conversation, including file contents
# and command output, so it gets its own bucket rather than a prefix in the
# dependency cache bucket. The control plane stores it when the run ends; the
# coding proxy, the migrator, the native gateway and every worker pod get no
# access. Access is granted to the control plane's Google service account
# (database-iam.tf, bound to its Kubernetes service account via Workload
# Identity) on this bucket only.

resource "google_storage_bucket" "session_transcripts" {
  count = var.session_transcripts_enabled ? 1 : 0

  project  = var.project_id
  name     = var.session_transcripts_bucket_name
  location = var.region

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  # The control plane prunes expired transcripts only when it stores a new one.
  # This rule removes them on schedule even when no new run is stored. deploy/
  # gke/up.sh passes the same number to the control plane as
  # RUN_TRANSCRIPT_RETENTION_DAYS (the session_transcripts_retention_days
  # output), so the two cannot disagree.
  lifecycle_rule {
    condition {
      age            = var.session_transcripts_retention_days
      matches_prefix = ["run-transcripts/"]
    }
    action {
      type = "Delete"
    }
  }

  lifecycle {
    precondition {
      condition     = var.session_transcripts_bucket_name != ""
      error_message = "session_transcripts_bucket_name is required when session_transcripts_enabled is true."
    }
    precondition {
      condition     = var.session_transcripts_bucket_name != var.dependency_cache_bucket_name
      error_message = "session_transcripts_bucket_name must differ from dependency_cache_bucket_name: transcripts get a bucket of their own."
    }
  }
}

# objectAdmin (read, write, delete objects), on this bucket, for the control
# plane's service account only. A bucket-level member, not a project-level role.
resource "google_storage_bucket_iam_member" "session_transcripts_control_plane" {
  count = var.session_transcripts_enabled ? 1 : 0

  bucket = google_storage_bucket.session_transcripts[0].name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.database["app"].email}"
}
