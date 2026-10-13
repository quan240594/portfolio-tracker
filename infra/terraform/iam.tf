# Function-specific least-privilege policies. Logs + X-Ray are added by modules/lambda.

locals {
  imports_objects_arn = "${aws_s3_bucket.imports.arn}/imports/*"
  ssm_params_arn      = "arn:${local.partition}:ssm:${local.region}:${local.account_id}:parameter${local.ssm_prefix}/*"
}

data "aws_iam_policy_document" "api" {
  statement {
    sid = "DynamoDB"
    actions = [
      "dynamodb:Query",
      "dynamodb:GetItem",
      "dynamodb:BatchGetItem",
      "dynamodb:PutItem",
      "dynamodb:DeleteItem",
      "dynamodb:UpdateItem",
    ]
    resources = [aws_dynamodb_table.main.arn]
  }

  statement {
    sid       = "PutEvents"
    actions   = ["events:PutEvents"]
    resources = [aws_cloudwatch_event_bus.main.arn]
  }

  statement {
    sid       = "PresignImportUpload"
    actions   = ["s3:PutObject"]
    resources = [local.imports_objects_arn]
  }
}

data "aws_iam_policy_document" "ingest" {
  statement {
    sid = "DynamoDB"
    actions = [
      "dynamodb:Query",
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:BatchWriteItem",
    ]
    resources = [aws_dynamodb_table.main.arn]
  }

  statement {
    sid       = "ReadImports"
    actions   = ["s3:GetObject"]
    resources = [local.imports_objects_arn]
  }

  statement {
    sid       = "PutEvents"
    actions   = ["events:PutEvents"]
    resources = [aws_cloudwatch_event_bus.main.arn]
  }

  statement {
    sid = "ConsumeIngestQueue"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
    ]
    resources = [module.ingest_queue.queue_arn]
  }
}

data "aws_iam_policy_document" "prices_common" {
  statement {
    sid = "DynamoDB"
    actions = [
      "dynamodb:Query",
      "dynamodb:GetItem",
      "dynamodb:BatchGetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:BatchWriteItem",
    ]
    resources = [aws_dynamodb_table.main.arn]
  }

  statement {
    sid       = "ReadApiKeys"
    actions   = ["ssm:GetParameter", "ssm:GetParameters"]
    resources = [local.ssm_params_arn]
  }

  # SecureStrings use the AWS managed aws/ssm key; restrict Decrypt to calls made through SSM.
  statement {
    sid       = "DecryptApiKeys"
    actions   = ["kms:Decrypt"]
    resources = ["arn:${local.partition}:kms:${local.region}:${local.account_id}:key/*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ViaService"
      values   = ["ssm.${local.region}.amazonaws.com"]
    }
  }

  statement {
    sid       = "PutEvents"
    actions   = ["events:PutEvents"]
    resources = [aws_cloudwatch_event_bus.main.arn]
  }
}

data "aws_iam_policy_document" "prices_refresh" {
  source_policy_documents = [data.aws_iam_policy_document.prices_common.json]
}

data "aws_iam_policy_document" "prices_enrich" {
  source_policy_documents = [data.aws_iam_policy_document.prices_common.json]

  statement {
    sid = "ConsumeEnrichQueue"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
    ]
    resources = [module.enrich_queue.queue_arn]
  }
}
