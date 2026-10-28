# Session transcripts (sessionResume): a private bucket the control plane -- and
# nothing else -- can read and write. Off unless session_transcripts_enabled =
# true; with it off this file creates nothing and existing plans do not change.
#
# A transcript holds a coding run's whole conversation, including file contents
# and command output, so it gets its own bucket rather than a prefix in the
# dependency cache bucket. The control plane stores it when the run ends. Access
# is a policy on the control plane's Pod Identity role (database-iam.tf) scoped
# to this one bucket; the coding proxy, migrator, native gateway and every
# worker pod get no access to it.

resource "aws_s3_bucket" "session_transcripts" {
  count = var.session_transcripts_enabled ? 1 : 0

  bucket        = var.session_transcripts_bucket_name
  force_destroy = false

  lifecycle {
    precondition {
      condition     = var.session_transcripts_bucket_name != ""
      error_message = "session_transcripts_bucket_name is required when session_transcripts_enabled is true."
    }
    precondition {
      condition     = var.session_transcripts_bucket_name != var.dependency_cache_bucket_name
      error_message = "session_transcripts_bucket_name must differ from dependency_cache_bucket_name: transcripts get a bucket of their own."
    }
  }
}

resource "aws_s3_bucket_public_access_block" "session_transcripts" {
  count = var.session_transcripts_enabled ? 1 : 0

  bucket                  = aws_s3_bucket.session_transcripts[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "session_transcripts" {
  count = var.session_transcripts_enabled ? 1 : 0

  bucket = aws_s3_bucket.session_transcripts[0].id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "session_transcripts" {
  count = var.session_transcripts_enabled ? 1 : 0

  bucket = aws_s3_bucket.session_transcripts[0].id

  # The control plane prunes expired transcripts only when it stores a new one.
  # This rule removes them on schedule even when no new run is stored. Pass the
  # same number to the control plane as RUN_TRANSCRIPT_RETENTION_DAYS (the
  # session_transcripts_retention_days output).
  rule {
    id     = "expire-transcripts"
    status = "Enabled"
    filter {
      prefix = "run-transcripts/"
    }
    expiration {
      days = var.session_transcripts_retention_days
    }
  }

  # Uploads over the multipart threshold that never completed keep their parts
  # (and bill for them) until aborted.
  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_s3_bucket_policy" "session_transcripts" {
  count = var.session_transcripts_enabled ? 1 : 0

  bucket = aws_s3_bucket.session_transcripts[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "DenyInsecureTransport"
      Effect    = "Deny"
      Principal = "*"
      Action    = "s3:*"
      Resource  = [aws_s3_bucket.session_transcripts[0].arn, "${aws_s3_bucket.session_transcripts[0].arn}/*"]
      Condition = { Bool = { "aws:SecureTransport" = "false" } }
    }]
  })

  depends_on = [aws_s3_bucket_public_access_block.session_transcripts]
}

# What the S3 blob adapter calls: GetObject (read and HEAD), PutObject (single
# and multipart parts), DeleteObject, and the multipart bookkeeping calls. A HEAD
# on a missing key answers 403 instead of 404 without s3:ListBucket, so the
# adapter could not tell "not there" from "not allowed".
resource "aws_iam_role_policy" "session_transcripts_control_plane" {
  count = var.session_transcripts_enabled ? 1 : 0

  name = "session-transcripts-bucket"
  role = aws_iam_role.database["app"].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "Objects"
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject",
          "s3:AbortMultipartUpload",
          "s3:ListMultipartUploadParts",
        ]
        Resource = "${aws_s3_bucket.session_transcripts[0].arn}/*"
      },
      {
        Sid      = "ListBucket"
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.session_transcripts[0].arn
      },
    ]
  })
}
