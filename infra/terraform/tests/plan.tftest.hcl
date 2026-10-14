# Offline plan tests with a mocked AWS provider (Terraform >= 1.7):
#   terraform init -backend=false && terraform test -var artifacts_dir=<dir with services/*/dist/*.zip>

mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = { account_id = "123456789012" }
  }
  mock_data "aws_partition" {
    defaults = { partition = "aws" }
  }
  mock_data "aws_canonical_user_id" {
    defaults = { id = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" }
  }
  mock_data "aws_region" {
    defaults = { name = "eu-west-1" }
  }
  mock_data "aws_iam_policy_document" {
    defaults = { json = "{\"Version\":\"2012-10-17\",\"Statement\":[]}" }
  }
}

variables {
  env = "dev"
}

run "dev_defaults" {
  command = plan

  assert {
    condition     = aws_dynamodb_table.main.name == "portfolio-tracker-dev" && !aws_dynamodb_table.main.deletion_protection_enabled
    error_message = "unexpected table name / deletion protection for dev"
  }

  assert {
    condition     = aws_s3_bucket.imports.bucket == "portfolio-tracker-imports-dev-123456789012"
    error_message = "imports bucket naming"
  }

  assert {
    condition = (
      aws_s3_bucket_logging.imports.target_prefix == "s3/imports/" &&
      aws_s3_bucket_logging.web.target_prefix == "s3/web/"
    )
    error_message = "imports and web buckets must log to the shared access-logs bucket under distinct prefixes"
  }

  assert {
    condition = (
      aws_s3_bucket.access_logs.bucket == "portfolio-tracker-access-logs-dev-123456789012" &&
      aws_s3_bucket.access_logs.force_destroy &&
      aws_s3_bucket_ownership_controls.access_logs.rule[0].object_ownership == "BucketOwnerPreferred" &&
      aws_s3_bucket_lifecycle_configuration.access_logs.rule[0].expiration[0].days == 90
    )
    error_message = "access-logs bucket: naming, force_destroy (dev), ACL-enabled ownership, 90-day expiry"
  }

  assert {
    condition = (
      one(aws_cloudfront_distribution.web.logging_config).prefix == "cloudfront/web/" &&
      !one(aws_cloudfront_distribution.web.logging_config).include_cookies
    )
    error_message = "CloudFront must log to the access-logs bucket"
  }

  assert {
    condition     = length(aws_sns_topic.alarms) == 0 && length(aws_kms_key.alarms) == 0
    error_message = "no alarm topic / KMS key without alarm_email"
  }

  assert {
    condition     = module.ingest_queue.queue_name == "portfolio-tracker-ingest-dev"
    error_message = "ingest queue naming"
  }

  assert {
    condition = (
      local.api_key_param_env["TWELVEDATA_API_KEY_PARAM"] == "/portfolio-tracker/dev/twelvedata-api-key" &&
      local.api_key_param_env["ALPHAVANTAGE_API_KEY_PARAM"] == "/portfolio-tracker/dev/alphavantage-api-key" &&
      length(local.api_key_param_env) == 4
    )
    error_message = "API key param env mapping"
  }

  assert {
    condition     = length(aws_cognito_user_pool.main) == 0 && aws_apigatewayv2_route.default.authorization_type == "NONE"
    error_message = "auth must be disabled by default"
  }

  assert {
    condition     = length(aws_iam_role.github_deploy) == 0
    error_message = "github deploy role must be disabled by default"
  }
}

run "prod_with_auth_and_github" {
  command = plan

  variables {
    env         = "prod"
    enable_auth = true
    github_repo = "owner/portfolio-tracker"
    alarm_email = "ops@example.com"
  }

  assert {
    condition     = aws_dynamodb_table.main.deletion_protection_enabled
    error_message = "prod must enable deletion protection"
  }

  assert {
    condition     = aws_apigatewayv2_route.default.authorization_type == "JWT"
    error_message = "JWT authorizer expected when enable_auth"
  }

  assert {
    condition     = length(aws_iam_role.github_deploy) == 1 && length(aws_sns_topic.alarms) == 1
    error_message = "github role / SNS topic expected"
  }

  assert {
    condition = (
      aws_kms_key.alarms[0].enable_key_rotation &&
      aws_kms_alias.alarms[0].name == "alias/portfolio-tracker-alarms-prod"
    )
    error_message = "alarms KMS key must rotate and have the env alias"
  }

  assert {
    condition     = !aws_s3_bucket.access_logs.force_destroy
    error_message = "prod access-logs bucket must not be force-destroyable"
  }
}

run "rejects_invalid_env" {
  command = plan

  variables {
    env = "staging"
  }

  expect_failures = [var.env]
}
