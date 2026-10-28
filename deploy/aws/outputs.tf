output "region" {
  value = var.region
}

output "account_id" {
  description = "Account the module was applied in."
  value       = local.account_id
}

output "vpc_id" {
  description = "The VPC (created, or existing_vpc_id). The load balancer controller needs it passed explicitly: IMDS is closed to pods."
  value       = local.vpc_id
}

output "public_subnet_ids" {
  description = "Subnets for the internet-facing load balancer."
  value       = local.public_subnet_ids
}

output "private_subnet_ids" {
  description = "Subnets of the EKS nodes and pods."
  value       = local.private_subnet_ids
}

output "database_subnet_cidrs" {
  description = "CIDRs of the database subnets, for the workloads' database egress NetworkPolicies."
  value       = local.database_subnet_cidrs
}

output "cluster_name" {
  value = aws_eks_cluster.main.name
}

output "cluster_arn" {
  value = aws_eks_cluster.main.arn
}

output "cluster_endpoint" {
  description = "Kubernetes API endpoint."
  value       = aws_eks_cluster.main.endpoint
}

output "cluster_security_group_id" {
  description = "The EKS-managed cluster security group (on every node)."
  value       = aws_eks_cluster.main.vpc_config[0].cluster_security_group_id
}

output "kubeconfig_command" {
  description = "Creates the kubectl context for this cluster."
  value       = "aws eks update-kubeconfig --region ${var.region} --name ${aws_eks_cluster.main.name}"
}

output "sandbox_node_selector" {
  description = "nodeSelector the gvisor RuntimeClass's scheduling block must add."
  value       = { (local.sandbox_label_key) = local.sandbox_value }
}

output "sandbox_toleration" {
  description = "Taint on sandbox nodes (key=value:effect) the gvisor RuntimeClass must tolerate."
  value       = "${local.sandbox_taint_key}=${local.sandbox_value}:NoSchedule"
}

output "database_endpoint" {
  description = "RDS host name (TLS server name for sslmode=verify-full)."
  value       = aws_db_instance.main.address
}

output "database_port" {
  value = aws_db_instance.main.port
}

output "database_name" {
  value = aws_db_instance.main.db_name
}

output "database_resource_id" {
  description = "The instance's resource id (the dbuser ARNs' instance part)."
  value       = aws_db_instance.main.resource_id
}

output "database_master_username" {
  value = aws_db_instance.main.username
}

output "database_master_user_secret_arn" {
  description = "Secrets Manager secret holding the RDS-managed master password, for the one-off grants bootstrap."
  value       = try(aws_db_instance.main.master_user_secret[0].secret_arn, null)
}

output "database_users" {
  description = "Postgres user per workload; the grants bootstrap creates them with GRANT rds_iam."
  value       = local.database_users
}

output "database_role_arns" {
  value = { for k, r in aws_iam_role.database : k => r.arn }
}

output "ecr_registry" {
  description = "REGISTRY for docker buildx bake; images are <ecr_registry>/<target>."
  value       = "${local.account_id}.dkr.ecr.${var.region}.${local.dns_suffix}/${var.name_prefix}"
}

output "ecr_repository_urls" {
  value = { for k, r in aws_ecr_repository.images : k => r.repository_url }
}

output "secret_name_prefix" {
  description = "Secrets are named <secret_name_prefix><id>."
  value       = "${var.name_prefix}/"
}

output "secret_arns" {
  value = { for k, s in aws_secretsmanager_secret.deployment : k => s.arn }
}

output "external_secrets_role_arn" {
  value = aws_iam_role.external_secrets.arn
}

output "certificate_arn" {
  description = "ACM certificate for hostname, for the load balancer's HTTPS listener."
  value       = aws_acm_certificate.control_plane.arn
}

output "certificate_validation_records" {
  description = "DNS records that validate the certificate. Create them yourself when route53_zone_id is null."
  value = [for o in aws_acm_certificate.control_plane.domain_validation_options : {
    name  = o.resource_record_name
    type  = o.resource_record_type
    value = o.resource_record_value
  }]
}

output "waf_web_acl_arn" {
  description = "WAF web ACL for the load balancer."
  value       = aws_wafv2_web_acl.control_plane.arn
}

output "lbc_role_arn" {
  value = aws_iam_role.lbc.arn
}

output "dependency_cache_bucket" {
  description = "Name of the run dependency cache bucket (BLOB_STORE_S3_BUCKET); empty when dependency_cache_enabled is false. Its region is the module's region output (BLOB_STORE_S3_REGION)."
  value       = try(aws_s3_bucket.dependency_cache[0].bucket, "")
}

output "session_transcripts_bucket" {
  description = "Name of the session transcripts bucket (the control plane's BLOB_STORE_S3_BUCKET); empty when session_transcripts_enabled is false. Its region is the module's region output (BLOB_STORE_S3_REGION)."
  value       = try(aws_s3_bucket.session_transcripts[0].bucket, "")
}

output "session_transcripts_retention_days" {
  description = "Days the session transcripts bucket keeps a transcript; give it to the control plane as RUN_TRANSCRIPT_RETENTION_DAYS."
  value       = var.session_transcripts_retention_days
}
