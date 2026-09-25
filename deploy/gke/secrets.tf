# Secret Manager holds every secret the GKE deployment needs. Terraform creates
# the secrets and decides who may read them -- never a version. seed-secrets.mjs
# (run by up.sh) adds the values over stdin, so no secret value passes through
# Terraform or lands in its state. Compare deploy/gcp/secrets.tf, which does
# pass values through `secret_data`; this module deliberately does not.

locals {
  # "database-url" is deliberately not in this set: the password login it
  # backed is retired, and this module no longer creates or reads it.
  # Dropping a key out of this set makes Terraform plan to DESTROY that
  # secret and its IAM binding -- and on a deployment that still has it,
  # secrets_deletion_protection makes that destroy fail. An existing
  # deployment deletes the secret with gcloud FIRST, before applying this
  # change, so a subsequent refresh finds it already gone and drops both
  # resources from state instead of trying to destroy them. Do NOT turn off
  # secrets_deletion_protection to get past the error instead -- that
  # unprotects every other secret in this set too, including
  # SECRET_APP_KEY and the auth keys. See the guide (getting-started-gke.md)
  # for the exact gcloud command.
  secret_ids = toset([
    "openai-api-key",
    "anthropic-api-key",
    "secret-app-key",
    "github-app-id",
    "github-app-private-key",
    "auth-signing-key",
    "auth-credential-hash-key",
  ])

  # The namespace and service account are fixed by the manifests in
  # deploy/kind-coding/manifests/overlays/gke-autopilot/secrets.
  #
  # Granted to the Kubernetes service account directly, as a Workload Identity
  # principal: there is no Google service account and no key. Only this one
  # service account in this one namespace can read these secrets.
  secrets_reader = "principal://iam.googleapis.com/projects/${data.google_project.this.number}/locations/global/workloadIdentityPools/${var.project_id}.svc.id.goog/subject/ns/wardby-coding/sa/wardby-secrets-reader"
}

data "google_project" "this" {
  project_id = var.project_id
}

resource "google_project_service" "secretmanager" {
  project = var.project_id
  service = "secretmanager.googleapis.com"

  # Other things in the project may use Secret Manager.
  disable_on_destroy = false
}

resource "google_secret_manager_secret" "deployment" {
  for_each = local.secret_ids

  project   = var.project_id
  secret_id = "${var.name_prefix}-${each.key}"

  replication {
    auto {}
  }

  # These outlive the cluster on purpose: a rebuild must get the same auth keys
  # and SECRET_APP_KEY back. Losing SECRET_APP_KEY makes every stored credential
  # unreadable.
  deletion_protection = var.secrets_deletion_protection

  depends_on = [google_project_service.secretmanager]
}

resource "google_secret_manager_secret_iam_member" "reader" {
  for_each = local.secret_ids

  project   = var.project_id
  secret_id = google_secret_manager_secret.deployment[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = local.secrets_reader
}
