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

variable "migration_image" {
  description = "Fully-qualified image reference for the one-off Prisma migration job, built from deploy/Dockerfile's `migration` target (not the `runtime` target used by container_image). No default: this module doesn't build or publish the image."
  type        = string
}

variable "openai_api_key_value" {
  description = "OpenAI API key, exposed to the container as OPENAI_API_KEY. No default, and never write a real value to a committed .tfvars file - pass it as -var or via TF_VAR_openai_api_key_value from a local, gitignored source. Null (the default) skips creating this secret. The app registers providers additively by credential presence, so this and anthropic_api_key_value can both be set at once."
  type        = string
  default     = null
  sensitive   = true
}

variable "anthropic_api_key_value" {
  description = "Anthropic API key, exposed to the container as ANTHROPIC_API_KEY. Same rules as openai_api_key_value - no default, never committed, both may be set at once."
  type        = string
  default     = null
  sensitive   = true
}

variable "auth_provider" {
  description = "Which AuthProvider the app runs. \"delegating\" (the expected choice for most deployments) makes reevo a pure OAuth resource server in front of your own IdP — it never issues tokens, and users are administered entirely in that IdP. \"self-hosted\" makes reevo its own authorization server with login keys issued by the `reevo auth` CLI; it needs no external identity system, which makes it the zero-config way to stand a deployment up."
  type        = string
  default     = "self-hosted"
  validation {
    condition     = contains(["self-hosted", "delegating"], var.auth_provider)
    error_message = "auth_provider must be \"self-hosted\" or \"delegating\"."
  }
  validation {
    condition     = var.auth_provider != "delegating" || (var.auth_issuer != null && var.auth_jwks_uri != null)
    error_message = "auth_issuer and auth_jwks_uri are required when auth_provider is \"delegating\"."
  }
}

variable "auth_issuer" {
  description = "Your IdP's issuer URL, exactly as it appears in the `iss` claim of the tokens it mints (e.g. \"https://login.example.com/realms/prod\"). Required when auth_provider is \"delegating\"; ignored otherwise, since self-hosted mode is its own issuer."
  type        = string
  default     = null
}

variable "auth_jwks_uri" {
  description = "Your IdP's JWKS endpoint, used to verify token signatures (e.g. \"https://login.example.com/realms/prod/protocol/openid-connect/certs\"). Required when auth_provider is \"delegating\"; ignored otherwise. Must be reachable from the Cloud Run service."
  type        = string
  default     = null
}

variable "mcp_canonical_uri_override" {
  description = "MCP_CANONICAL_URI value when create_domain_mapping is false. Only needed for a domainless deployment: the *.run.app URL doesn't exist until the Cloud Run service is created, so it can't be known on the first apply. Workflow: apply once (the app fails its own MCP_CANONICAL_URI check and won't serve real traffic yet, but every other resource - Cloud SQL, secrets, IAM - is created correctly), read the real URL from the cloud_run_service_url output, then apply again with this variable set to that URL. Ignored when create_domain_mapping is true (domain_name is used instead)."
  type        = string
  default     = "https://placeholder.invalid"
}
