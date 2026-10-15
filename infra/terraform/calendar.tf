# Calendar refresh (see docs/architecture.md "Calendar").
#
# - prices-calendar Lambda: daily Scheduler run that stores upcoming earnings dates (one Alpha Vantage call for every
#   tracked ticker) and splits/dividends for a rotating, budgeted subset of the tracked tickers (EODHD).
# - Same artifact (prices.zip), runtime, environment and key access as prices-refresh; only the handler, the log group and
#   the schedule differ. The budgets are enforced in the handler (persisted per day in DynamoDB), these variables only
#   configure them.

variable "calendar_cron" {
  description = "EventBridge Scheduler expression of the daily calendar refresh (earnings dates, splits, dividends)."
  type        = string
  default     = "cron(30 5 * * ? *)"
}

variable "calendar_timeout" {
  description = "Timeout (s) of the prices-calendar Lambda."
  type        = number
  default     = 300

  validation {
    condition     = var.calendar_timeout >= 30 && var.calendar_timeout <= 900
    error_message = "calendar_timeout must be between 30 and 900 seconds."
  }
}

variable "calendar_alphavantage_daily_calls" {
  description = "Alpha Vantage calls per day the calendar may use (free tier: 25/day shared with profile enrichment; one call lists every tracked ticker)."
  type        = number
  default     = 1

  validation {
    condition     = var.calendar_alphavantage_daily_calls >= 0 && var.calendar_alphavantage_daily_calls <= 10
    error_message = "calendar_alphavantage_daily_calls must be between 0 and 10."
  }
}

variable "calendar_eodhd_daily_calls" {
  description = "EODHD calls per day the calendar may use (free tier: 20/day shared with quotes and enrichment; every symbol check costs 2: splits + dividends)."
  type        = number
  default     = 8

  validation {
    condition     = var.calendar_eodhd_daily_calls >= 0 && var.calendar_eodhd_daily_calls <= 20
    error_message = "calendar_eodhd_daily_calls must be between 0 and 20."
  }
}

variable "calendar_recheck_days" {
  description = "Days before the splits/dividends of a symbol are checked again."
  type        = number
  default     = 7

  validation {
    condition     = var.calendar_recheck_days >= 1 && var.calendar_recheck_days <= 60
    error_message = "calendar_recheck_days must be between 1 and 60."
  }
}

variable "calendar_earnings_horizon" {
  description = "Alpha Vantage EARNINGS_CALENDAR horizon."
  type        = string
  default     = "12month"

  validation {
    condition     = contains(["3month", "6month", "12month"], var.calendar_earnings_horizon)
    error_message = "calendar_earnings_horizon must be one of: 3month, 6month, 12month."
  }
}

locals {
  calendar_handler = "prices.calendar_handlers.calendar_refresh"
  calendar_env = merge(local.prices_common_env, {
    CALENDAR_EARNINGS_HORIZON         = var.calendar_earnings_horizon
    CALENDAR_ALPHAVANTAGE_DAILY_CALLS = tostring(var.calendar_alphavantage_daily_calls)
    CALENDAR_EODHD_DAILY_CALLS        = tostring(var.calendar_eodhd_daily_calls)
    CALENDAR_RECHECK_DAYS             = tostring(var.calendar_recheck_days)
  })
}

# The prices-common statements already cover everything the refresh does: Query/GetItem/BatchGetItem, PutItem, UpdateItem
# (markers and budgets), BatchWriteItem (puts and the deletion of rescheduled report dates), SSM + KMS for the API keys.
data "aws_iam_policy_document" "prices_calendar" {
  source_policy_documents = [data.aws_iam_policy_document.prices_common.json]
}

module "prices_calendar_lambda" {
  source = "./modules/lambda"

  function_name      = "${local.app}-prices-calendar-${var.env}"
  description        = "Daily calendar refresh: earnings dates, splits and dividends of tracked tickers"
  filename           = local.artifacts.prices
  handler            = local.calendar_handler
  runtime            = "python3.12"
  memory_size        = 256
  timeout            = var.calendar_timeout
  log_retention_days = var.log_retention_days
  policy_json        = data.aws_iam_policy_document.prices_calendar.json

  environment = local.calendar_env
}

data "aws_iam_policy_document" "scheduler_calendar" {
  statement {
    actions = ["lambda:InvokeFunction"]
    resources = [
      module.prices_calendar_lambda.function_arn,
      "${module.prices_calendar_lambda.function_arn}:*",
    ]
  }
}

resource "aws_iam_role_policy" "scheduler_calendar" {
  name   = "invoke-prices-calendar"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler_calendar.json
}

resource "aws_scheduler_schedule" "prices_calendar" {
  name                         = "${local.app}-prices-calendar-${var.env}"
  description                  = "Refresh earnings dates, splits and dividends of tracked tickers"
  schedule_expression          = var.calendar_cron
  schedule_expression_timezone = var.price_refresh_timezone

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = module.prices_calendar_lambda.function_arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ trigger = "scheduled" })

    # The refresh is idempotent and budgeted, so a retry after a crash cannot overspend a provider's free tier.
    retry_policy {
      maximum_event_age_in_seconds = 3600
      maximum_retry_attempts       = 1
    }
  }
}

output "prices_calendar_function_name" {
  value = module.prices_calendar_lambda.function_name
}
