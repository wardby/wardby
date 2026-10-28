# Session transcripts: nothing by default; when on, a private bucket of their
# own, expiring run-transcripts/ after the retention days, and a policy on the
# control plane's role only. Mock providers: nothing is created.
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
  mock_resource "aws_s3_bucket" {
    defaults = { arn = "arn:aws:s3:::example-bucket" }
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

run "off_by_default_creates_nothing" {
  command = apply

  assert {
    condition     = length(aws_s3_bucket.session_transcripts) == 0 && length(aws_iam_role_policy.session_transcripts_control_plane) == 0
    error_message = "No bucket and no policy unless session_transcripts_enabled."
  }
  assert {
    condition     = output.session_transcripts_bucket == "" && output.session_transcripts_retention_days == 30
    error_message = "The bucket output is empty when off; retention defaults to 30 days."
  }
}

run "on_creates_a_private_bucket_scoped_to_the_control_plane_role" {
  command = apply

  variables {
    session_transcripts_enabled        = true
    session_transcripts_bucket_name    = "example-session-transcripts"
    session_transcripts_retention_days = 45
  }

  assert {
    condition     = output.session_transcripts_bucket == "example-session-transcripts" && output.session_transcripts_retention_days == 45
    error_message = "The outputs name the bucket and the retention the control plane must be given."
  }
  assert {
    condition = (
      aws_s3_bucket_public_access_block.session_transcripts[0].block_public_acls &&
      aws_s3_bucket_public_access_block.session_transcripts[0].block_public_policy &&
      aws_s3_bucket_public_access_block.session_transcripts[0].ignore_public_acls &&
      aws_s3_bucket_public_access_block.session_transcripts[0].restrict_public_buckets
    )
    error_message = "All four public access blocks are on."
  }
  assert {
    condition = (
      [for r in aws_s3_bucket_lifecycle_configuration.session_transcripts[0].rule : r.expiration[0].days if r.id == "expire-transcripts"][0] == 45 &&
      [for r in aws_s3_bucket_lifecycle_configuration.session_transcripts[0].rule : r.filter[0].prefix if r.id == "expire-transcripts"][0] == "run-transcripts/" &&
      [for r in aws_s3_bucket_lifecycle_configuration.session_transcripts[0].rule : r.abort_incomplete_multipart_upload[0].days_after_initiation if r.id == "abort-incomplete-multipart-uploads"][0] == 1
    )
    error_message = "Transcripts under run-transcripts/ expire after the retention days; incomplete multipart uploads abort after one day."
  }
  assert {
    condition     = aws_iam_role_policy.session_transcripts_control_plane[0].role == aws_iam_role.database["app"].id
    error_message = "The bucket policy is attached to the control plane role only."
  }
  assert {
    condition     = length(aws_iam_role_policy.dependency_cache_proxy) == 0
    error_message = "Turning transcripts on gives the proxy no bucket access."
  }
}

run "both_on_keeps_the_buckets_and_roles_apart" {
  command = apply

  variables {
    dependency_cache_enabled        = true
    dependency_cache_bucket_name    = "example-dependency-cache"
    session_transcripts_enabled     = true
    session_transcripts_bucket_name = "example-session-transcripts"
  }

  assert {
    condition     = aws_s3_bucket.session_transcripts[0].bucket != aws_s3_bucket.dependency_cache[0].bucket
    error_message = "Transcripts and the dependency cache use different buckets."
  }
  assert {
    condition = (
      aws_iam_role_policy.session_transcripts_control_plane[0].role == aws_iam_role.database["app"].id &&
      aws_iam_role_policy.dependency_cache_proxy[0].role == aws_iam_role.database["proxy"].id
    )
    error_message = "Each bucket's policy sits on its own role."
  }
}

run "refuses_the_dependency_cache_bucket" {
  command = plan

  variables {
    dependency_cache_enabled        = true
    dependency_cache_bucket_name    = "example-shared"
    session_transcripts_enabled     = true
    session_transcripts_bucket_name = "example-shared"
  }

  expect_failures = [aws_s3_bucket.session_transcripts]
}

run "refuses_a_retention_outside_1_to_3650_days" {
  command = plan

  variables {
    session_transcripts_retention_days = 0
  }

  expect_failures = [var.session_transcripts_retention_days]
}
