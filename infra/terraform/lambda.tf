module "api_lambda" {
  source = "./modules/lambda"

  function_name      = "${local.app}-api-${var.env}"
  description        = "Portfolio tracker REST API"
  filename           = local.artifacts.api
  handler            = "index.handler"
  runtime            = "nodejs22.x"
  memory_size        = 512
  timeout            = local.lambda_timeouts.api
  log_retention_days = var.log_retention_days
  policy_json        = data.aws_iam_policy_document.api.json

  environment = {
    TABLE_NAME          = aws_dynamodb_table.main.name
    EVENT_BUS_NAME      = aws_cloudwatch_event_bus.main.name
    IMPORT_BUCKET       = aws_s3_bucket.imports.bucket
    BASE_CURRENCY       = var.base_currency
    DEMO_USER_ID        = var.demo_user_id
    CORS_ALLOWED_ORIGIN = local.web_origin
    LOG_LEVEL           = var.log_level
  }
}

module "ingest_lambda" {
  source = "./modules/lambda"

  function_name      = "${local.app}-ingest-${var.env}"
  description        = "CSV import ingestion"
  filename           = local.artifacts.ingest
  handler            = "index.handler"
  runtime            = "nodejs22.x"
  memory_size        = 512
  timeout            = local.lambda_timeouts.ingest
  log_retention_days = var.log_retention_days
  policy_json        = data.aws_iam_policy_document.ingest.json

  environment = {
    TABLE_NAME     = aws_dynamodb_table.main.name
    EVENT_BUS_NAME = aws_cloudwatch_event_bus.main.name
    IMPORT_BUCKET  = aws_s3_bucket.imports.bucket
    LOG_LEVEL      = var.log_level
  }
}

module "prices_refresh_lambda" {
  source = "./modules/lambda"

  function_name      = "${local.app}-prices-refresh-${var.env}"
  description        = "Scheduled market-data refresh"
  filename           = local.artifacts.prices
  handler            = "prices.handlers.scheduled_refresh"
  runtime            = "python3.12"
  memory_size        = 256
  timeout            = local.lambda_timeouts.prices_refresh
  log_retention_days = var.log_retention_days
  policy_json        = data.aws_iam_policy_document.prices_refresh.json

  environment = merge(local.prices_common_env, {
    EU_REFRESH_HOURS = var.eu_refresh_hours
  })
}

module "prices_enrich_lambda" {
  source = "./modules/lambda"

  function_name      = "${local.app}-prices-enrich-${var.env}"
  description        = "Enrich newly tracked tickers on TransactionsChanged"
  filename           = local.artifacts.prices
  handler            = "prices.handlers.on_transactions_changed"
  runtime            = "python3.12"
  memory_size        = 256
  timeout            = local.lambda_timeouts.prices_enrich
  log_retention_days = var.log_retention_days
  policy_json        = data.aws_iam_policy_document.prices_enrich.json
  environment        = local.prices_common_env
}

resource "aws_lambda_event_source_mapping" "ingest" {
  event_source_arn        = module.ingest_queue.queue_arn
  function_name           = module.ingest_lambda.function_arn
  batch_size              = 5
  function_response_types = ["ReportBatchItemFailures"]
}

resource "aws_lambda_event_source_mapping" "prices_enrich" {
  event_source_arn        = module.enrich_queue.queue_arn
  function_name           = module.prices_enrich_lambda.function_arn
  batch_size              = 5
  function_response_types = ["ReportBatchItemFailures"]
}
