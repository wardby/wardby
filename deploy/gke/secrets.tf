# Secret Manager holds every secret the GKE deployment needs. Terraform creates
# the secrets and decides who may read them -- never a version. seed-secrets.mjs
# (run by up.sh) adds the values over stdin, so no secret value passes through
# Terraform or lands in its state. Compare deploy/gcp/secrets.tf, which does
# pass values through `secret_data`; this module deliberately does not.

locals {
  # "database-url" is deliberately not in this set: the password login it
  # backed is retired, and this module no longer creates or reads it. On a
  # deployment that still has the secret from before this change, delete it
  # yourself with gcloud before applying -- Terraform's deletion protection
  # here is enforced only by Terraform, so a secret this module stops
  # managing is simply left behind, not deleted. See the guide (getting-
  # started-gke.md) for the exact command.
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
