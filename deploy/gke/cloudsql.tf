# Cloud SQL Postgres reachable only from inside the VPC, for a wardby control
# plane running in GKE.
#
# Why private IP and not the public one deploy/gcp uses: there, Cloud Run
# reaches the database through the Cloud SQL connector, which GKE pods cannot
# use. The alternatives for a pod are a public IP with authorized networks --
# which means allowlisting whatever egress address the node happens to have --
# or an Auth Proxy sidecar in every workload that talks to the database. A
# private IP is one host:port that both the control plane and the coding proxy
# reach directly, with no sidecar and no allowlist to drift.

data "google_compute_network" "target" {
  name    = var.network
  project = var.project_id
}

# The range Google's service-producer network gets inside this VPC. No `address`
# is set on purpose: letting GCP allocate means it cannot overlap a subnet that
# already exists in the VPC, which matters when peering into a shared network
# rather than one this module created.
resource "google_compute_global_address" "private_ip" {
  name          = "${var.name_prefix}-sql-private-ip"
  project       = var.project_id
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = var.private_ip_prefix_length
  network       = data.google_compute_network.target.id
}

# The peering itself. One per VPC per producer: if something else in this
# project already peered servicenetworking into the same network, Terraform
# adopts rather than duplicates it -- but it will also REPLACE that peering's
# reserved ranges with the one above, so check for an existing peering before
# the first apply on a shared VPC.
resource "google_service_networking_connection" "private_vpc" {
  network                 = data.google_compute_network.target.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.private_ip.name]
}

resource "google_sql_database_instance" "main" {
  name             = "${var.name_prefix}-control-plane"
  project          = var.project_id
  region           = var.region
  database_version = var.database_version

  # The instance cannot be created until the peering exists: without it there is
  # no private range to draw an address from, and the API rejects the create.
  depends_on = [google_service_networking_connection.private_vpc]

  deletion_protection = var.deletion_protection

  settings {
    # Explicit, because the default is not. Cloud SQL now defaults new instances
    # to ENTERPRISE_PLUS, which rejects every shared-core tier:
    #
    #   Error 400: Invalid request: Invalid Tier (db-f1-micro) for
    #   (ENTERPRISE_PLUS) Edition. Use a predefined Tier like
    #   db-perf-optimized-N-* instead.
    #
    # Enterprise Plus starts at a dedicated-core machine and costs several times
    # a micro instance. Naming the edition here means the tier variable means
    # what it says, rather than failing at create time on an unrelated default.
    edition           = var.edition
    tier              = var.tier
    availability_type = var.availability_type
    disk_size         = var.disk_size_gb
    disk_autoresize   = true

    # Required for the IAM database users in database-iam.tf.
    database_flags {
      name  = "cloudsql.iam_authentication"
      value = "on"
    }

    # REQUIRED refuses any connection that does not come through the Auth
    # Proxy or a Cloud SQL connector, so a leaked password is useless on the
    # network. NOT_REQUIRED by default until the password login is retired;
    # see var.connector_enforcement.
    connector_enforcement = var.connector_enforcement

    ip_configuration {
      # No public IP at all. This is the whole point of the module: there is no
      # internet-facing surface to authorize, allowlist or forget about.
      ipv4_enabled    = false
      private_network = data.google_compute_network.target.id
      # Refuse unencrypted connections. Prisma negotiates TLS by default, so
      # this costs nothing and removes a way to be wrong later.
      ssl_mode = "ENCRYPTED_ONLY"
    }

    backup_configuration {
      enabled                        = true
      start_time                     = var.backup_start_time
      point_in_time_recovery_enabled = true
    }

    maintenance_window {
      # Sunday early UTC. A control plane that fires scheduled agents has no
      # truly quiet hour, but a restart here is the least disruptive guess.
      day  = 7
      hour = 6
    }
  }
}

resource "google_sql_database" "app" {
  name     = var.database_name
  instance = google_sql_database_instance.main.name
  project  = var.project_id
}

# The password-login user is gone from this module: every workload now
# authenticates through database-iam.tf's IAM users. The built-in owner
# (var.database_user) still exists and still owns every table -- it is
# managed by bootstrap-database-iam.sh, which creates it on a new deployment
# and sets its password through the Cloud SQL Admin API only when needed
# (e.g. the one-off `--password-from-stdin` cutover), never storing it here
# or anywhere else. `removed` (not a plain delete) tells Terraform to drop
# this resource from state without touching the live user, matching the
# `deletion_policy = "ABANDON"` this resource used to carry: once migrations
# have created tables owned by this user, Postgres refuses to drop it, and a
# destroy would fail partway through with objects already gone.
removed {
  from = google_sql_user.app

  lifecycle {
    destroy = false
  }
}
