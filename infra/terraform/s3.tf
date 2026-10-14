# CSV imports bucket. The SPA uploads via presigned PUT to imports/{userId}/{importId}.csv;
# S3 emits "Object Created" to the default EventBridge bus (see events.tf).
# Server access logs go to the shared access-logs bucket (see access_logs.tf).
resource "aws_s3_bucket" "imports" {
  bucket        = "${local.app}-imports-${var.env}-${local.account_id}"
  force_destroy = var.env != "prod"
}

resource "aws_s3_bucket_logging" "imports" {
  bucket        = aws_s3_bucket.imports.id
  target_bucket = aws_s3_bucket.access_logs.id
  target_prefix = local.access_logs_prefix.imports
  depends_on    = [aws_s3_bucket_policy.access_logs]
}

resource "aws_s3_bucket_ownership_controls" "imports" {
  bucket = aws_s3_bucket.imports.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "imports" {
  bucket                  = aws_s3_bucket.imports.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "imports" {
  bucket = aws_s3_bucket.imports.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

data "aws_iam_policy_document" "imports_bucket" {
  statement {
    sid     = "DenyInsecureTransport"
    effect  = "Deny"
    actions = ["s3:*"]
    resources = [
      aws_s3_bucket.imports.arn,
      "${aws_s3_bucket.imports.arn}/*",
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

resource "aws_s3_bucket_policy" "imports" {
  bucket     = aws_s3_bucket.imports.id
  policy     = data.aws_iam_policy_document.imports_bucket.json
  depends_on = [aws_s3_bucket_public_access_block.imports]
}

resource "aws_s3_bucket_cors_configuration" "imports" {
  bucket = aws_s3_bucket.imports.id
  cors_rule {
    allowed_methods = ["PUT"]
    allowed_origins = local.cors_origins
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "imports" {
  bucket = aws_s3_bucket.imports.id

  rule {
    id     = "expire-imports"
    status = "Enabled"
    filter {
      prefix = "imports/"
    }
    expiration {
      days = 30
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_s3_bucket_notification" "imports" {
  bucket      = aws_s3_bucket.imports.id
  eventbridge = true
}
