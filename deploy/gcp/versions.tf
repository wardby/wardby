terraform {
  required_version = ">= 1.10"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.3"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # No backend block: state storage is a per-deployment choice, documented
  # in ../README.md rather than hardcoded here. Configure one (e.g. `backend
  # "gcs" { bucket = "..." }`) before running `terraform init` for real.
}

provider "google" {
  project = var.project_id
  region  = var.region
}
