data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  app        = "portfolio-tracker"
  account_id = data.aws_caller_identity.current.account_id
  partition  = data.aws_partition.current.partition
  region     = data.aws_region.current.name

  name = "${local.app}-${var.env}"

  artifacts_dir = var.artifacts_dir != "" ? var.artifacts_dir : "${path.root}/../.."
  artifacts = {
    api    = "${local.artifacts_dir}/services/api/dist/api.zip"
    ingest = "${local.artifacts_dir}/services/ingest/dist/ingest.zip"
    prices = "${local.artifacts_dir}/services/prices/dist/prices.zip"
  }

  lambda_timeouts = {
    api            = 10
    ingest         = 60
    prices_refresh = 300
    prices_enrich  = 120
  }

  web_origin   = "https://${aws_cloudfront_distribution.web.domain_name}"
  cors_origins = distinct(concat([local.web_origin], var.extra_cors_origins))

  ssm_prefix = "/${local.app}/${var.env}"
  # e.g. twelvedata-api-key -> TWELVEDATA_API_KEY_PARAM = /portfolio-tracker/dev/twelvedata-api-key
  api_key_param_env = {
    for n in var.market_data_api_key_params :
    "${upper(replace(n, "-", "_"))}_PARAM" => "${local.ssm_prefix}/${n}"
  }

  prices_common_env = merge({
    TABLE_NAME           = aws_dynamodb_table.main.name
    EVENT_BUS_NAME       = aws_cloudwatch_event_bus.main.name
    BASE_CURRENCY        = var.base_currency
    LOG_LEVEL            = var.log_level
    MARKET_DATA_PROVIDER = var.market_data_provider
  }, local.api_key_param_env)
}
