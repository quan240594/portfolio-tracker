# Offline plan tests of broker.tf (Trading 212 sync), mocked AWS provider (Terraform >= 1.7):
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
  env         = "dev"
  enable_auth = false # non-prod must choose explicitly (see plan.tftest.hcl)
}

run "broker_sync_defaults" {
  command = plan

  assert {
    condition = (
      module.broker_sync_lambda.function_name == "portfolio-tracker-broker-sync-dev" &&
      local.broker_secret_prefix == "/portfolio-tracker/dev/broker/trading212" &&
      aws_scheduler_schedule.broker_sync.schedule_expression == "cron(30 6 * * ? *)" &&
      one(aws_scheduler_schedule.broker_sync.target).input == "{\"all\":true}"
    )
    error_message = "daily schedule must send {all:true} to the sync Lambda; secrets live under /portfolio-tracker/{env}/broker/trading212"
  }

  assert {
    condition = (
      one([for s in data.aws_iam_policy_document.broker_sync.statement : s if s.sid == "ReadTrading212Credentials"]).actions == toset(["secretsmanager:GetSecretValue"]) &&
      one([for s in data.aws_iam_policy_document.broker_sync.statement : s if s.sid == "ReadTrading212Credentials"]).resources == toset(["arn:aws:secretsmanager:eu-west-1:123456789012:secret:/portfolio-tracker/dev/broker/trading212/*"])
    )
    error_message = "the sync Lambda may only read secrets under the broker prefix"
  }

  assert {
    condition = (
      !contains(flatten([for s in data.aws_iam_policy_document.api_broker.statement : tolist(s.actions)]), "secretsmanager:GetSecretValue") &&
      contains(flatten([for s in data.aws_iam_policy_document.api_broker.statement : tolist(s.actions)]), "secretsmanager:PutSecretValue") &&
      contains(flatten([for s in data.aws_iam_policy_document.api_broker.statement : tolist(s.actions)]), "lambda:InvokeFunction")
    )
    error_message = "the API may write and delete credentials and start the sync, but never read a secret"
  }

  assert {
    condition     = aws_lambda_function_event_invoke_config.broker_sync.maximum_retry_attempts == 0
    error_message = "asynchronous sync invocations must not be retried blindly"
  }
}

run "rejects_invalid_broker_timeout" {
  command = plan

  variables {
    broker_sync_timeout = 30
  }

  expect_failures = [var.broker_sync_timeout]
}
