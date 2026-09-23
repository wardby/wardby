# The GKE Autopilot cluster coding runs execute in, and the registry holding
# their images.
#
# This exists because the cluster it describes was originally created by typing
# gcloud commands. That made the deployment unreproducible: the database was in
# Terraform while the thing it serves was folklore. The resources below were
# written against a live cluster and imported into state, so `terraform plan`
# on an untouched cluster is empty.
#
# Autopilot rather than Standard, deliberately: coding-run pods are the only
# real workload, they are short-lived and bursty, and Autopilot bills per pod
# rather than per node. It also removes node management from the threat model --
# there is no node OS for an escaped workload to land on that an operator is
# responsible for patching.

resource "google_container_cluster" "runs" {
  name     = var.cluster_name
  project  = var.project_id
  location = var.region

  enable_autopilot = true

  network    = data.google_compute_network.target.id
  subnetwork = var.subnetwork

  # REGULAR trades the newest features for versions that have been through
  # canary. gVisor's RuntimeClass and the Gateway API are both long past that
  # bar, so RAPID buys nothing here and costs predictability.
  release_channel {
    channel = var.release_channel
  }

  # Autopilot enables Workload Identity itself; naming it keeps the value in
  # code rather than as an implicit default, since anything that later
  # federates a Google service account depends on this pool existing.
  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }

  deletion_protection = var.cluster_deletion_protection

  lifecycle {
    ignore_changes = [
      # Autopilot manages the master version through the release channel. Left
      # unignored, every upgrade Google performs shows as drift and the next
      # apply tries to pin the cluster back to whatever version it was created
      # with.
      min_master_version,
      # The pod and services ranges are allocated by GKE at creation from the
      # VPC. They are attributes of the cluster that exists, not inputs to it,
      # and an apply that "corrects" them would replace the cluster.
      ip_allocation_policy,
    ]
  }
}

# Holds the runtime, migration and coding-worker images. Images must be
# referenced by digest, so this repository is the trust root for what actually
# runs: the launcher refuses a tag.
resource "google_artifact_registry_repository" "images" {
  project       = var.project_id
  location      = var.region
  repository_id = var.artifact_registry_name
  format        = "DOCKER"
  mode          = "STANDARD_REPOSITORY"
  description   = "wardby runtime, migration and coding-worker images"
}
