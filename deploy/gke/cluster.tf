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

  # No lifecycle/ignore_changes block, deliberately.
  #
  # An earlier revision ignored min_master_version and ip_allocation_policy,
  # claiming they prevented release-channel upgrades and GKE-assigned pod and
  # service ranges from reading as drift. That was wrong, and removing them was
  # verified: `terraform plan` reports "No changes" either way. ignore_changes
  # only suppresses a diff for an attribute actually SET in config, and neither
  # is set here -- GKE computes both, and an unset optional attribute produces
  # no diff on its own.
  #
  # They were also a trap. Had anyone later added min_master_version or an
  # ip_allocation_policy block, ignore_changes would have swallowed it silently,
  # with nothing in the plan to show the setting was being discarded. An inert
  # safeguard that disarms a future real one is worse than no safeguard.
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
