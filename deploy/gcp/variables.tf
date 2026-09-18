variable "project_id" {
  description = "GCP project id to deploy into. No default: every deployment must set this explicitly."
  type        = string
}

variable "region" {
  description = "GCP region for all resources (e.g. \"us-central1\")."
  type        = string
}

variable "name_prefix" {
  description = "Prefix applied to every resource name, so multiple copies of this module can coexist in one project or across projects without colliding."
  type        = string
  default     = "reevo-run"
}

variable "create_domain_mapping" {
  description = "Whether to create a custom domain mapping for the Cloud Run service. Requires domain_name and prior domain ownership verification (gcloud domains verify) - see SETUP.md. Set false to test/deploy without a domain; the service still gets a free *.run.app URL (see the cloud_run_service_url output) either way."
  type        = bool
  default     = true
}

variable "domain_name" {
  description = "Custom domain to map to the Cloud Run service (e.g. \"reevo.example.com\"). Required only when create_domain_mapping is true; ignored otherwise."
  type        = string
  default     = null
  validation {
    condition     = !var.create_domain_mapping || var.domain_name != null
    error_message = "domain_name is required when create_domain_mapping is true."
  }
}

variable "min_instance_count" {
  description = "Minimum Cloud Run replicas. 2+ avoids a scale-to-zero gap in scheduler availability and a single point of failure across restarts/deploys."
  type        = number
  default     = 2
}

variable "max_instance_count" {
  description = "Maximum Cloud Run replicas."
  type        = number
  default     = 10
}

variable "cloudsql_tier" {
  description = "Cloud SQL machine tier (e.g. \"db-f1-micro\" for a cheap baseline, \"db-custom-2-8192\" for production)."
  type        = string
  default     = "db-f1-micro"
}

variable "cloudsql_availability_type" {
  description = "Cloud SQL availability: \"ZONAL\" (single zone, cheaper) or \"REGIONAL\" (synchronous standby + automatic failover, ~2x cost)."
  type        = string
  default     = "ZONAL"
  validation {
    condition     = contains(["ZONAL", "REGIONAL"], var.cloudsql_availability_type)
    error_message = "cloudsql_availability_type must be \"ZONAL\" or \"REGIONAL\"."
  }
}

variable "cloudsql_deletion_protection" {
  description = "Prevent accidental destroy of the Cloud SQL instance. Defaults on; a copy of this module used for disposable dev/test environments should set this false explicitly."
  type        = bool
  default     = true
}

variable "container_image" {
  description = "Fully-qualified image reference for the Cloud Run service (e.g. a digest-pinned image built from ../Dockerfile). No default: this module doesn't build or publish the image."
  type        = string
}
