variable "project_id" {
  description = "GCP project that will hold the database and the VPC peering."
  type        = string
}

variable "region" {
  description = "Region for the Cloud SQL instance. Put it where the cluster is: a private-IP instance in another region still works, but every query pays the cross-region round trip."
  type        = string
  default     = "us-central1"
}

variable "name_prefix" {
  description = "Prefix for every resource name, so several environments can share a project."
  type        = string
  default     = "wardby"
}

variable "network" {
  description = <<-EOT
    Name of the VPC network to peer the database into.

    This MUST be the network the GKE cluster runs on. A cluster's network is
    fixed at creation, and VPC peering is not transitive -- an instance peered
    into a different VPC is unreachable from the cluster, with no error until a
    connection times out at run time. "default" is the GCP auto-created network
    that a cluster lands on when none is specified.
  EOT
  type        = string
  default     = "default"
}

variable "private_ip_prefix_length" {
  description = "Size of the range reserved for Google's service-producer network. /16 is what Google's own guidance uses; the address itself is auto-allocated, so it cannot collide with subnets already in the VPC."
  type        = number
  default     = 16
}

variable "database_version" {
  description = "Cloud SQL Postgres version."
  type        = string
  default     = "POSTGRES_16"
}

variable "edition" {
  description = "ENTERPRISE or ENTERPRISE_PLUS. Must be ENTERPRISE for any shared-core tier (db-f1-micro, db-g1-small) -- Cloud SQL defaults new instances to ENTERPRISE_PLUS, which refuses them at create time."
  type        = string
  default     = "ENTERPRISE"
}

variable "tier" {
  description = "Machine type. db-f1-micro is the cheapest Postgres tier and is adequate for a control plane whose write volume is one row per run; db-custom-<cpu>-<mb> for anything real."
  type        = string
  default     = "db-f1-micro"
}

variable "disk_size_gb" {
  description = "Initial disk size. Autoresize is on, so this is a floor, not a ceiling."
  type        = number
  default     = 10
}

variable "availability_type" {
  description = "ZONAL or REGIONAL. REGIONAL is high-availability and costs roughly twice as much."
  type        = string
  default     = "ZONAL"
}

variable "database_name" {
  description = "Database to create inside the instance."
  type        = string
  default     = "wardby"
}

variable "database_user" {
  description = "Application login. Its password is generated and never stored in this module's variables."
  type        = string
  default     = "wardby"
}

variable "deletion_protection" {
  description = <<-EOT
    Guard against deleting the instance.

    Read this before a teardown: the value is read from Terraform state, so it
    must be applied as false and THEN destroyed. Discovering it at destroy time
    means an extra apply on an instance you were trying to remove.
  EOT
  type        = bool
  default     = true
}

variable "backup_start_time" {
  description = "Daily backup window in UTC, HH:MM. Backups and point-in-time recovery are the reason to use a managed database at all, so they are on by default."
  type        = string
  default     = "08:00"
}

variable "cluster_name" {
  description = "Name of the GKE Autopilot cluster coding runs execute in."
  type        = string
  default     = "wardby-coding"
}

variable "subnetwork" {
  description = "Subnetwork for the cluster. Must be in var.network; \"default\" is the auto-created subnet a cluster lands on when none is given."
  type        = string
  default     = "default"
}

variable "release_channel" {
  description = "GKE release channel: RAPID, REGULAR or STABLE. REGULAR is the default because gVisor and the Gateway API are long past canary, so RAPID buys nothing and costs predictability."
  type        = string
  default     = "REGULAR"
}

variable "cluster_deletion_protection" {
  description = <<-EOT
    Guard against deleting the cluster. Same trap as the database's flag: the
    value is read from Terraform state, so it must be applied as false and THEN
    destroyed.
  EOT
  type        = bool
  default     = true
}

variable "artifact_registry_name" {
  description = "Artifact Registry repository holding the runtime, migration and coding-worker images."
  type        = string
  default     = "wardby"
}
