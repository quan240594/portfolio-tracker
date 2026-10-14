# Shared access-logs bucket: S3 server access logs (imports + web buckets) and CloudFront standard
# (legacy) logs. Prefixes: s3/imports/, s3/web/, cloudfront/web/.
# This bucket is the logging target, so it does not log to itself (that would loop).

locals {
  # Canonical user of the CloudFront log delivery account (awslogsdelivery); fixed by AWS.
  cloudfront_log_delivery_canonical_id = "c4c1ede66af53448b93c283ce9448c4ba468c9432aa01d700d3878632f77d2d0"

  access_logs_prefix = {
    imports    = "s3/imports/"
    web        = "s3/web/"
    cloudfront = "cloudfront/web/"
  }
}

data "aws_canonical_user_id" "current" {}

resource "aws_s3_bucket" "access_logs" {
  bucket        = "${local.app}-access-logs-${var.env}-${local.account_id}"
  force_destroy = var.env != "prod"
}

# CloudFront standard logging still delivers through ACLs, so ACLs must be enabled on this bucket.
# BucketOwnerPreferred makes the bucket owner own every delivered object.
resource "aws_s3_bucket_ownership_controls" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}

# Owner + CloudFront log delivery (awslogsdelivery) FULL_CONTROL. S3 server access logs are delivered
# by the bucket policy below, so the legacy S3 log-delivery group grant is not needed.
resource "aws_s3_bucket_acl" "access_logs" {
  bucket     = aws_s3_bucket.access_logs.id
  depends_on = [aws_s3_bucket_ownership_controls.access_logs]

  access_control_policy {
    owner {
      id = data.aws_canonical_user_id.current.id
    }

    grant {
      permission = "FULL_CONTROL"
      grantee {
        type = "CanonicalUser"
        id   = data.aws_canonical_user_id.current.id
      }
    }

    grant {
      permission = "FULL_CONTROL"
      grantee {
        type = "CanonicalUser"
        id   = local.cloudfront_log_delivery_canonical_id
      }
    }
  }
}

resource "aws_s3_bucket_public_access_block" "access_logs" {
  bucket                  = aws_s3_bucket.access_logs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# S3 server access logging only supports SSE-S3 on the target bucket.
resource "aws_s3_bucket_server_side_encryption_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "access_logs" {
  bucket = aws_s3_bucket.access_logs.id

  rule {
    id     = "expire-access-logs"
    status = "Enabled"
    filter {}
    expiration {
      days = var.access_log_retention_days
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

data "aws_iam_policy_document" "access_logs_bucket" {
  statement {
    sid       = "AllowS3ServerAccessLogDelivery"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.access_logs.arn}/${local.access_logs_prefix.imports}*", "${aws_s3_bucket.access_logs.arn}/${local.access_logs_prefix.web}*"]
    principals {
      type        = "Service"
      identifiers = ["logging.s3.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = [aws_s3_bucket.imports.arn, aws_s3_bucket.web.arn]
    }
  }

  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.access_logs.arn,
      "${aws_s3_bucket.access_logs.arn}/*",
    ]
    principals {
      type        = "*"
      identifiers = ["*"]
    }
    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "access_logs" {
  bucket     = aws_s3_bucket.access_logs.id
  policy     = data.aws_iam_policy_document.access_logs_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.access_logs]
}
