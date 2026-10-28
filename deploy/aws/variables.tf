# --- General -----------------------------------------------------------------

variable "region" {
  description = "AWS region for every resource in this module."
  type        = string

  validation {
    condition     = can(regex("^[a-z]{2}(-[a-z]+)+-[0-9]+$", var.region))
    error_message = "region must look like us-east-1."
  }
}

variable "name_prefix" {
  description = "Prefix for every resource name, and the EKS cluster's name. Lowercase letters, digits and single hyphens; 3-20 characters; starts with a letter. IAM role names are account-wide, so it must be unique in the account, not just in the region."
  type        = string
  default     = "wardby"

  validation {
    # No "--": RDS identifiers and snapshot names refuse consecutive hyphens.
    condition     = can(regex("^[a-z][a-z0-9-]{1,18}[a-z0-9]$", var.name_prefix)) && !strcontains(var.name_prefix, "--")
    error_message = "name_prefix must be 3-20 lowercase letters, digits or hyphens, starting with a letter, not ending with a hyphen and without two hyphens in a row."
  }
}

variable "namespace" {
  description = "Kubernetes namespace the Wardby workloads run in. Must match the manifests."
  type        = string
  default     = "wardby-coding"
}

variable "tags" {
  description = "Extra tags added to every resource."
  type        = map(string)
  default     = {}
}

# --- Network -----------------------------------------------------------------

variable "vpc_cidr" {
  description = "CIDR of the VPC this module creates (ignored with existing_vpc_id). /16 to /20; the private (node and pod) subnets get a quarter of it each, because the VPC CNI gives every pod a VPC address."
  type        = string
  default     = "10.40.0.0/16"

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0)) && tonumber(split("/", var.vpc_cidr)[1]) >= 16 && tonumber(split("/", var.vpc_cidr)[1]) <= 20
    error_message = "vpc_cidr must be a valid CIDR between /16 and /20."
  }
}

variable "single_nat_gateway" {
  description = "One NAT gateway for the whole VPC (cheaper) instead of one per availability zone (survives a zone outage). Ignored with existing_vpc_id."
  type        = bool
  default     = true
}

variable "existing_vpc_id" {
  description = <<-EOT
    Deploy into a VPC you already have instead of creating one. Set it together
    with existing_public_subnet_ids, existing_private_subnet_ids and
    existing_database_subnet_ids (at least two subnets each, in different
    availability zones). The module then creates no VPC, subnet, route or NAT
    gateway: outbound internet from the private subnets (for image pulls and the
    gVisor download) is yours to provide.
  EOT
  type        = string
  default     = null

  validation {
    condition = (
      var.existing_vpc_id == null
      ? length(var.existing_public_subnet_ids) + length(var.existing_private_subnet_ids) + length(var.existing_database_subnet_ids) == 0
      : length(var.existing_public_subnet_ids) >= 2 && length(var.existing_private_subnet_ids) >= 2 && length(var.existing_database_subnet_ids) >= 2
    )
    error_message = "Set existing_vpc_id together with at least two subnet ids in each of existing_public_subnet_ids, existing_private_subnet_ids and existing_database_subnet_ids, or set none of them."
  }
}

variable "existing_public_subnet_ids" {
  description = "With existing_vpc_id: subnets for the internet-facing load balancer."
  type        = list(string)
  default     = []
}

variable "existing_private_subnet_ids" {
  description = "With existing_vpc_id: subnets for the EKS nodes and pods. Need outbound internet (NAT) or VPC endpoints."
  type        = list(string)
  default     = []
}

variable "existing_database_subnet_ids" {
  description = "With existing_vpc_id: subnets for the RDS instance. May be the private subnets; isolated subnets (no internet route) are better."
  type        = list(string)
  default     = []
}

# --- Cluster -----------------------------------------------------------------

variable "kubernetes_version" {
  description = "EKS Kubernetes minor version."
  type        = string
  default     = "1.36"

  validation {
    condition     = can(regex("^1\\.[0-9]+$", var.kubernetes_version))
    error_message = "kubernetes_version must look like 1.36."
  }
}

variable "endpoint_public_access" {
  description = "Expose the Kubernetes API on a public endpoint restricted to public_access_cidrs. With false, the API is reachable only from inside the VPC (bring a VPN or bastion)."
  type        = bool
  default     = true
}

variable "public_access_cidrs" {
  description = "CIDRs allowed to reach the public Kubernetes API endpoint, e.g. your own address as a /32. Required while endpoint_public_access is true; 0.0.0.0/0 is refused."
  type        = list(string)
  default     = []

  validation {
    condition = !var.endpoint_public_access || (
      length(var.public_access_cidrs) > 0
      && alltrue([for c in var.public_access_cidrs : can(cidrhost(c, 0))])
      && !contains(var.public_access_cidrs, "0.0.0.0/0")
    )
    error_message = "With endpoint_public_access, public_access_cidrs must list at least one valid CIDR and must not contain 0.0.0.0/0."
  }
}

variable "additional_admin_principal_arns" {
  description = "IAM principals (role or user ARNs) given cluster-admin. Only the identity that created the cluster is admin otherwise, so list every later operator here; do not list the creator, whose access entry EKS already made (the apply would fail on the duplicate)."
  type        = list(string)
  default     = []
}

variable "cluster_log_types" {
  description = "EKS control-plane log types sent to CloudWatch Logs."
  type        = list(string)
  default     = ["api", "audit", "authenticator"]
}

variable "cluster_log_retention_days" {
  description = "Days CloudWatch Logs keeps the control-plane logs. One of CloudWatch's allowed retention values (1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653)."
  type        = number
  default     = 90

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.cluster_log_retention_days)
    error_message = "cluster_log_retention_days must be one of CloudWatch's allowed retention values: 1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288 or 3653."
  }
}

variable "upgrade_support_type" {
  description = "STANDARD: when standard support for the version ends, EKS upgrades the control plane itself; apply again afterwards so the add-ons and node groups follow. EXTENDED: stays on the version, billed at the extended-support rate."
  type        = string
  default     = "STANDARD"

  validation {
    condition     = contains(["STANDARD", "EXTENDED"], var.upgrade_support_type)
    error_message = "upgrade_support_type must be STANDARD or EXTENDED."
  }
}

variable "cluster_deletion_protection" {
  description = "Guard against deleting the cluster. Apply false first, then destroy."
  type        = bool
  default     = true
}

# --- Nodes -------------------------------------------------------------------

variable "node_ami_release_version" {
  description = "Pin the EKS-optimized AL2023 AMI release (e.g. 1.36.0-20261001) for both node groups. null takes the latest for kubernetes_version when a node group is created; nodes move to a newer AMI only when the launch template or Kubernetes version changes, or when you pin a newer release. Pin it when a gVisor or containerd change needs a known-good pairing."
  type        = string
  default     = null
}

variable "system_instance_types" {
  description = "Instance types for the system node group (control plane, proxy, gateway, controllers)."
  type        = list(string)
  default     = ["m6i.large"]
}

variable "system_min_size" {
  description = "System node group minimum size."
  type        = number
  default     = 2
}

variable "system_desired_size" {
  description = "System node group initial size. Terraform ignores later changes so manual scaling sticks."
  type        = number
  default     = 2

  validation {
    condition     = var.system_desired_size >= var.system_min_size && var.system_desired_size <= var.system_max_size
    error_message = "system_desired_size must be between system_min_size and system_max_size."
  }
}

variable "system_max_size" {
  description = "System node group maximum size."
  type        = number
  default     = 4
}

variable "system_disk_size_gb" {
  description = "Root volume size of system nodes, GiB."
  type        = number
  default     = 50
}

variable "sandbox_instance_types" {
  description = "Instance types for the gVisor sandbox node group, where coding-run and native-worker pods run. x86_64 only (the gVisor checksum is per architecture)."
  type        = list(string)
  default     = ["m6i.xlarge"]
}

variable "sandbox_min_size" {
  description = "Sandbox node group minimum size. 0 lets you scale the group to nothing when idle; nothing in this module scales it up automatically."
  type        = number
  default     = 0
}

variable "sandbox_desired_size" {
  description = "Sandbox node group initial size. Terraform ignores later changes so manual scaling sticks."
  type        = number
  default     = 1

  validation {
    condition     = var.sandbox_desired_size >= var.sandbox_min_size && var.sandbox_desired_size <= var.sandbox_max_size
    error_message = "sandbox_desired_size must be between sandbox_min_size and sandbox_max_size."
  }
}

variable "sandbox_max_size" {
  description = "Sandbox node group maximum size."
  type        = number
  default     = 3
}

variable "sandbox_disk_size_gb" {
  description = "Root volume size of sandbox nodes, GiB. Coding-worker images are large."
  type        = number
  default     = 100
}

variable "gvisor_version" {
  description = "gVisor release installed on sandbox nodes at boot (YYYYMMDD or YYYYMMDD.N)."
  type        = string
  default     = "20260921.0"

  validation {
    condition     = can(regex("^[0-9]{8}(\\.[0-9]+)?$", var.gvisor_version))
    error_message = "gvisor_version must look like 20260921.0."
  }
}

variable "gvisor_sha512" {
  description = "SHA-512 of gvisor.tar.bz2 for gvisor_version on x86_64 (the release's gvisor.tar.bz2.sha512). A node whose download does not match never joins the cluster."
  type        = string
  default     = "7c899979bed334f0987888c41e545cede8e1f7e67a257978c8de244c3867e32bc30d08491e9af36720273c502acd01d8d86c9844ebcbe125790c43fe6bdf563e"

  validation {
    condition     = can(regex("^[0-9a-f]{128}$", var.gvisor_sha512))
    error_message = "gvisor_sha512 must be 128 lowercase hex characters."
  }
}

variable "gvisor_download_base_url" {
  description = "Base URL of gVisor releases: <base>/<version>/x86_64/gvisor.tar.bz2. Point it at your own HTTPS mirror (e.g. an S3 bucket) to drop the boot-time dependency on Google's bucket."
  type        = string
  default     = "https://storage.googleapis.com/gvisor/releases/release"

  validation {
    condition     = can(regex("^https://[A-Za-z0-9._~:/%+-]+$", var.gvisor_download_base_url))
    error_message = "gvisor_download_base_url must be an https:// URL without quotes, spaces or shell characters."
  }
}

# --- Database ----------------------------------------------------------------

variable "database_engine_version" {
  description = "RDS Postgres major version."
  type        = string
  default     = "17"

  validation {
    condition     = can(regex("^[0-9]+$", var.database_engine_version))
    error_message = "database_engine_version must be a major version such as 17."
  }
}

variable "database_instance_class" {
  description = "RDS instance class."
  type        = string
  default     = "db.t4g.small"
}

variable "database_allocated_storage_gb" {
  description = "Initial storage, GiB. Storage autoscaling grows it up to database_max_allocated_storage_gb."
  type        = number
  default     = 20
}

variable "database_max_allocated_storage_gb" {
  description = "Storage autoscaling ceiling, GiB."
  type        = number
  default     = 100
}

variable "database_multi_az" {
  description = "Multi-AZ standby (high availability; roughly doubles the instance cost)."
  type        = bool
  default     = false
}

variable "database_backup_retention_days" {
  description = "Automated backup retention, days (1-35). Point-in-time recovery covers this window."
  type        = number
  default     = 7

  validation {
    condition     = var.database_backup_retention_days >= 1 && var.database_backup_retention_days <= 35
    error_message = "database_backup_retention_days must be between 1 and 35."
  }
}

variable "database_name" {
  description = "Database created inside the instance."
  type        = string
  default     = "wardby"
}

variable "database_master_username" {
  description = "RDS master user. Its password is generated and kept by RDS in Secrets Manager; it is used only to bootstrap the IAM database users and grants."
  type        = string
  default     = "wardby"

  validation {
    condition     = can(regex("^[a-z][a-z0-9_]{0,62}$", var.database_master_username))
    error_message = "database_master_username must be a lowercase Postgres identifier."
  }
}

variable "database_apply_immediately" {
  description = "Apply database changes now instead of in the next maintenance window. Set true for the apply that changes database_engine_version (a major upgrade, with downtime): otherwise RDS defers the change while Terraform tries to delete the old parameter group, and the apply fails until the window has passed."
  type        = bool
  default     = false
}

variable "database_deletion_protection" {
  description = "Guard against deleting the database. Apply false first, then destroy."
  type        = bool
  default     = true
}

# --- Images and secrets ------------------------------------------------------

variable "ecr_force_delete" {
  description = "Let terraform destroy delete ECR repositories that still hold images."
  type        = bool
  default     = false
}

variable "secrets_recovery_window_days" {
  description = "Days a deleted Secrets Manager secret can be restored (0 deletes at once, else 7-30). The secrets outlive the cluster on purpose: losing SECRET_APP_KEY makes every stored credential unreadable."
  type        = number
  default     = 30

  validation {
    condition     = var.secrets_recovery_window_days == 0 || (var.secrets_recovery_window_days >= 7 && var.secrets_recovery_window_days <= 30)
    error_message = "secrets_recovery_window_days must be 0 or between 7 and 30."
  }
}

variable "eso_namespace" {
  description = "Namespace of the External Secrets Operator controller."
  type        = string
  default     = "external-secrets"
}

variable "eso_service_account" {
  description = "Service account of the External Secrets Operator controller."
  type        = string
  default     = "external-secrets"
}

# --- Edge --------------------------------------------------------------------

variable "hostname" {
  description = "Public hostname of the control plane, e.g. wardby.your-company.com. The ACM certificate is issued for it."
  type        = string

  validation {
    condition     = can(regex("^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$", var.hostname))
    error_message = "hostname must be a fully qualified lowercase DNS name."
  }
}

variable "route53_zone_id" {
  description = "Route 53 hosted zone for hostname. When set, the module creates the certificate's validation records and waits for issuance; when null, it outputs the records for you to create."
  type        = string
  default     = null
}

variable "waf_rate_limit" {
  description = "Requests per client IP per waf_rate_limit_window_seconds before the WAF answers 429. Generous on purpose: MCP is chatty."
  type        = number
  default     = 300

  validation {
    condition     = var.waf_rate_limit >= 10
    error_message = "waf_rate_limit must be at least 10."
  }
}

variable "waf_rate_limit_window_seconds" {
  description = "Rate-limit evaluation window: 60, 120, 300 or 600 seconds."
  type        = number
  default     = 60

  validation {
    condition     = contains([60, 120, 300, 600], var.waf_rate_limit_window_seconds)
    error_message = "waf_rate_limit_window_seconds must be 60, 120, 300 or 600."
  }
}

variable "waf_managed_rules_action" {
  description = "count: the AWS common and known-bad-inputs rule groups only log matches. block: they block. Their body rules match code in MCP tool arguments and large webhook payloads, so start with count and check the rule groups' CloudWatch metrics and sampled requests (or configure WAF logging yourself) before blocking."
  type        = string
  default     = "count"

  validation {
    condition     = contains(["count", "block"], var.waf_managed_rules_action)
    error_message = "waf_managed_rules_action must be count or block."
  }
}

# --- Load balancer controller ------------------------------------------------

variable "lbc_version" {
  description = "AWS Load Balancer Controller release whose IAM policy the controller's role gets. Change together with lbc_iam_policy_sha256 and the controller's Helm chart."
  type        = string
  default     = "v3.5.0"
}

variable "lbc_iam_policy_sha256" {
  description = "SHA-256 of docs/install/iam_policy.json at lbc_version. Terraform refuses a downloaded policy that does not match."
  type        = string
  default     = "16f232c9d9f79366fe949c4550ad517a202380058a9e48d45a4e215044a20a6a"

  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.lbc_iam_policy_sha256))
    error_message = "lbc_iam_policy_sha256 must be 64 lowercase hex characters."
  }
}

variable "lbc_namespace" {
  description = "Namespace of the AWS Load Balancer Controller."
  type        = string
  default     = "kube-system"
}

variable "lbc_service_account" {
  description = "Service account of the AWS Load Balancer Controller."
  type        = string
  default     = "aws-load-balancer-controller"
}

# --- Run dependency cache -------------------------------------------------------

variable "dependency_cache_enabled" {
  description = "Create the run dependency cache bucket and let the coding proxy (only) use it. Off by default. The deployment also has to set BLOB_STORE=s3, BLOB_STORE_S3_BUCKET, BLOB_STORE_S3_REGION and WARDBY_DEPENDENCY_CACHE=true on the coding proxy."
  type        = bool
  default     = false
}

variable "dependency_cache_bucket_name" {
  description = "Name of the dependency cache bucket. S3 bucket names are global, so include something unique to you. Required when dependency_cache_enabled is true."
  type        = string
  default     = ""
}

variable "dependency_cache_max_age_days" {
  description = "Must equal the deployment's WARDBY_DEPENDENCY_CACHE_MAX_AGE_DAYS (default 14). The bucket deletes any object older than this plus 7 days, as a backstop for objects the proxy never recorded."
  type        = number
  default     = 14

  validation {
    condition     = var.dependency_cache_max_age_days >= 1 && floor(var.dependency_cache_max_age_days) == var.dependency_cache_max_age_days
    error_message = "dependency_cache_max_age_days must be a whole number of days, at least 1."
  }
}

# --- Session transcripts -------------------------------------------------------

variable "session_transcripts_enabled" {
  description = "Create the session transcripts bucket (for agents with sessionResume) and let the control plane (only) use it. Off by default. The deployment also has to set BLOB_STORE=s3, BLOB_STORE_S3_BUCKET, BLOB_STORE_S3_REGION and RUN_TRANSCRIPT_RETENTION_DAYS on the control plane."
  type        = bool
  default     = false
}

variable "session_transcripts_bucket_name" {
  description = "Name of the session transcripts bucket. S3 bucket names are global, so include something unique to you. Use a different bucket from the dependency cache. Required when session_transcripts_enabled is true."
  type        = string
  default     = ""
}

variable "session_transcripts_retention_days" {
  description = "Days to keep a session transcript. The bucket deletes run-transcripts/ objects older than this; give the control plane the same number as RUN_TRANSCRIPT_RETENTION_DAYS (the session_transcripts_retention_days output)."
  type        = number
  default     = 30

  validation {
    condition     = var.session_transcripts_retention_days >= 1 && var.session_transcripts_retention_days <= 3650 && floor(var.session_transcripts_retention_days) == var.session_transcripts_retention_days
    error_message = "session_transcripts_retention_days must be a whole number of days from 1 to 3650."
  }
}
