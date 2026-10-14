# Trading 212 sync (see docs/architecture.md "Trading 212 sync").
#
# - broker-sync Lambda: daily Scheduler run for every connected portfolio + on-demand runs started by the API.
# - Credentials live in Secrets Manager, one secret per user under the prefix below. Terraform creates no secret and
#   no secret value: the API writes them when a user connects (PUT /brokers/trading212).
# - Least privilege: the sync Lambda can only read secrets under the prefix; the API can only create/update/delete
#   them (it can never read one back) and invoke the sync function.

variable "broker_sync_cron" {
  description = "EventBridge Scheduler expression of the daily Trading 212 sync of every connected portfolio."
  type        = string
  default     = "cron(30 6 * * ? *)"
}

variable "broker_sync_timeout" {
  description = "Timeout (s) of the sync Lambda. The first sync reads the whole history within Trading 212's rate limits (20 requests/min)."
  type        = number
  default     = 900

  validation {
    condition     = var.broker_sync_timeout >= 60 && var.broker_sync_timeout <= 900
    error_message = "broker_sync_timeout must be between 60 and 900 seconds."
  }
}

locals {
  broker_function_name = "${local.app}-broker-sync-${var.env}"
  broker_artifact      = "${local.artifacts_dir}/services/broker-sync/dist/broker-sync.zip"
  # Secret names are `${prefix}/${userId}`; AWS appends a random suffix to the ARN, hence the trailing wildcard.
  broker_secret_prefix = "/${local.app}/${var.env}/broker/trading212"
  broker_secrets_arn   = "arn:${local.partition}:secretsmanager:${local.region}:${local.account_id}:secret:${local.broker_secret_prefix}/*"
  broker_function_arn  = "arn:${local.partition}:lambda:${local.region}:${local.account_id}:function:${local.broker_function_name}"
}

data "aws_iam_policy_document" "broker_sync" {
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
    sid       = "ReadTrading212Credentials"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [local.broker_secrets_arn]
  }

  statement {
    sid       = "PutEvents"
    actions   = ["events:PutEvents"]
    resources = [aws_cloudwatch_event_bus.main.arn]
  }
}

module "broker_sync_lambda" {
  source = "./modules/lambda"

  function_name      = local.broker_function_name
  description        = "Read-only Trading 212 import"
  filename           = local.broker_artifact
  handler            = "index.handler"
  runtime            = "nodejs22.x"
  memory_size        = 512
  timeout            = var.broker_sync_timeout
  log_retention_days = var.log_retention_days
  policy_json        = data.aws_iam_policy_document.broker_sync.json

  environment = {
    TABLE_NAME           = aws_dynamodb_table.main.name
    EVENT_BUS_NAME       = aws_cloudwatch_event_bus.main.name
    BROKER_SECRET_PREFIX = local.broker_secret_prefix
    LOG_LEVEL            = var.log_level
  }
}

# Failures are recorded in the sync state; a blind retry of an asynchronous invoke would only re-run a failing sync.
resource "aws_lambda_function_event_invoke_config" "broker_sync" {
  function_name                = module.broker_sync_lambda.function_name
  maximum_retry_attempts       = 0
  maximum_event_age_in_seconds = 3600
}

# The API manages the per-user secrets and starts on-demand syncs.
data "aws_iam_policy_document" "api_broker" {
  statement {
    sid = "ManageTrading212Credentials"
    actions = [
      "secretsmanager:CreateSecret",
      "secretsmanager:PutSecretValue",
      "secretsmanager:DeleteSecret",
      "secretsmanager:DescribeSecret",
    ]
    resources = [local.broker_secrets_arn]
  }

  statement {
    sid       = "StartBrokerSync"
    actions   = ["lambda:InvokeFunction"]
    resources = [module.broker_sync_lambda.function_arn]
  }
}

resource "aws_iam_role_policy" "api_broker" {
  name   = "${local.broker_function_name}-api-access"
  role   = module.api_lambda.role_name
  policy = data.aws_iam_policy_document.api_broker.json
}

data "aws_iam_policy_document" "scheduler_broker" {
  statement {
    actions   = ["lambda:InvokeFunction"]
    resources = [module.broker_sync_lambda.function_arn, "${module.broker_sync_lambda.function_arn}:*"]
  }
}

resource "aws_iam_role_policy" "scheduler_broker" {
  name   = "invoke-broker-sync"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler_broker.json
}

resource "aws_scheduler_schedule" "broker_sync" {
  name                         = "${local.app}-broker-sync-${var.env}"
  description                  = "Daily Trading 212 import of every connected portfolio"
  schedule_expression          = var.broker_sync_cron
  schedule_expression_timezone = var.price_refresh_timezone

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = module.broker_sync_lambda.function_arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ all = true })

    retry_policy {
      maximum_event_age_in_seconds = 3600
      maximum_retry_attempts       = 0
    }
  }
}

output "broker_sync_function_name" {
  value = module.broker_sync_lambda.function_name
}

output "broker_secret_prefix" {
  description = "Secrets Manager prefix of the per-user Trading 212 credentials (created by the API, not by Terraform)."
  value       = local.broker_secret_prefix
}
