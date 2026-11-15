# Mock providers: no AWS account, no credentials, nothing is created.
mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "111122223333", arn = "arn:aws:iam::111122223333:role/terraform-test" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws", dns_suffix = "amazonaws.com" }
  }
  mock_data "aws_availability_zones" {
    defaults = { names = ["us-test-1a", "us-test-1b", "us-test-1c", "us-test-1d"] }
  }
  mock_data "aws_subnet" {
    defaults = { cidr_block = "10.99.0.0/24" }
  }
  mock_data "aws_eks_addon_version" {
    defaults = { version = "v1.0.0-eksbuild.1" }
  }
  mock_resource "aws_db_instance" {
    defaults = {
      resource_id        = "db-TESTRESOURCEID"
      master_user_secret = [{ secret_arn = "arn:aws:secretsmanager:us-test-1:111122223333:secret:rds!db-test", kms_key_id = "", secret_status = "active" }]
    }
  }
  mock_resource "aws_iam_role" {
    defaults = { arn = "arn:aws:iam::111122223333:role/mock-role" }
  }
  mock_resource "aws_iam_policy" {
    defaults = { arn = "arn:aws:iam::111122223333:policy/mock-policy" }
  }
  mock_resource "aws_eks_cluster" {
    defaults = { arn = "arn:aws:eks:us-test-1:111122223333:cluster/wardby" }
  }
  mock_resource "aws_launch_template" {
    defaults = { id = "lt-0123456789abcdef0" }
  }
  mock_resource "aws_acm_certificate" {
    defaults = {
      domain_validation_options = [{
        domain_name           = "wardby.example.com"
        resource_record_name  = "_abc.wardby.example.com."
        resource_record_type  = "CNAME"
        resource_record_value = "_def.acm-validations.aws."
      }]
    }
  }
}

mock_provider "http" {
  mock_data "http" {
    defaults = { status_code = 200, response_body = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

variables {
  region                = "us-test-1"
  hostname              = "wardby.example.com"
  public_access_cidrs   = ["203.0.113.10/32"]
  lbc_iam_policy_sha256 = "8f907b489532ad56fb7c52f3acc89b27680ed51296bf03984ce78d2b7b96076a" # sha256 of the mock body above
}


run "images_and_secrets" {
  command = apply

  # Distinct ARN so an association wired to another role fails the role_arn
  # assert below (the header gives every role the same ARN).
  override_resource {
    target = aws_iam_role.external_secrets
    values = { arn = "arn:aws:iam::111122223333:role/wardby-external-secrets" }
  }

  assert {
    condition     = length(aws_ecr_repository.images) == 9 && aws_ecr_repository.images["runtime"].name == "wardby/runtime"
    error_message = "One repository per bake target, named <prefix>/<target>."
  }
  assert {
    condition     = alltrue([for r in aws_ecr_repository.images : r.image_scanning_configuration[0].scan_on_push && r.image_tag_mutability == "MUTABLE" && !r.force_delete])
    error_message = "Scan on push; mutable tags (bake pushes :latest, deploys pin digests); no force delete by default."
  }
  assert {
    condition     = output.ecr_registry == "111122223333.dkr.ecr.us-test-1.amazonaws.com/wardby"
    error_message = "ecr_registry is the bake REGISTRY value."
  }
  assert {
    condition     = length(aws_secretsmanager_secret.deployment) == 16 && aws_secretsmanager_secret.deployment["secret-app-key"].name == "wardby/secret-app-key"
    error_message = "One secret per id, named <prefix>/<id>."
  }
  assert {
    condition     = alltrue([for s in aws_secretsmanager_secret.deployment : s.recovery_window_in_days == 30])
    error_message = "30-day recovery window by default."
  }
  assert {
    condition     = toset(jsondecode(aws_iam_role_policy.external_secrets_read.policy).Statement[0].Action) == toset(["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"])
    error_message = "ESO may only read."
  }
  assert {
    condition     = toset(jsondecode(aws_iam_role_policy.external_secrets_read.policy).Statement[0].Resource) == toset([for s in aws_secretsmanager_secret.deployment : s.arn]) && length(jsondecode(aws_iam_role_policy.external_secrets_read.policy).Statement) == 1
    error_message = "ESO reads exactly this module's secrets."
  }
  assert {
    condition     = length(toset([for s in aws_secretsmanager_secret.deployment : s.arn])) == 16
    error_message = "Guard: the mock gives every secret a distinct ARN, so the set comparison above is not vacuous."
  }
  assert {
    condition     = aws_eks_pod_identity_association.external_secrets.namespace == "external-secrets" && aws_eks_pod_identity_association.external_secrets.service_account == "external-secrets" && aws_eks_pod_identity_association.external_secrets.role_arn == aws_iam_role.external_secrets.arn
    error_message = "The ESO controller's own service account gets the role."
  }
  assert {
    condition     = output.secret_name_prefix == "wardby/"
    error_message = "Secret names are <prefix>/<id>."
  }
}
