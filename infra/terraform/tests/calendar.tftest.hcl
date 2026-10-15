# Offline plan tests of calendar.tf (daily calendar refresh), mocked AWS provider (Terraform >= 1.7):
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

run "calendar_defaults" {
  command = plan

  assert {
    condition = (
      module.prices_calendar_lambda.function_name == "portfolio-tracker-prices-calendar-dev" &&
      aws_scheduler_schedule.prices_calendar.name == "portfolio-tracker-prices-calendar-dev" &&
      aws_scheduler_schedule.prices_calendar.schedule_expression == "cron(30 5 * * ? *)" &&
      aws_scheduler_schedule.prices_calendar.schedule_expression_timezone == "Europe/Amsterdam"
    )
    error_message = "the calendar refresh runs daily at 05:30 Europe/Amsterdam"
  }

  assert {
    condition = (
      one(aws_scheduler_schedule.prices_calendar.target).input == "{\"trigger\":\"scheduled\"}" &&
      one(one(aws_scheduler_schedule.prices_calendar.target).retry_policy).maximum_retry_attempts == 1 &&
      one(one(aws_scheduler_schedule.prices_calendar.target).retry_policy).maximum_event_age_in_seconds == 3600 &&
      aws_scheduler_schedule.prices_calendar.flexible_time_window[0].mode == "OFF"
    )
    error_message = "the schedule sends the scheduled trigger, no flexible window and retries once"
  }

  assert {
    condition = (
      local.calendar_handler == "prices.calendar_handlers.calendar_refresh" &&
      module.prices_calendar_lambda.log_group_name == "/aws/lambda/portfolio-tracker-prices-calendar-dev" &&
      local.calendar_env.TABLE_NAME == "portfolio-tracker-dev" &&
      local.calendar_env.MARKET_DATA_PROVIDER == "mock" &&
      local.calendar_env.CALENDAR_EARNINGS_HORIZON == "12month" &&
      local.calendar_env.CALENDAR_ALPHAVANTAGE_DAILY_CALLS == "1" &&
      local.calendar_env.CALENDAR_EODHD_DAILY_CALLS == "8" &&
      local.calendar_env.CALENDAR_RECHECK_DAYS == "7" &&
      local.calendar_env.TWELVEDATA_API_KEY_PARAM == "/portfolio-tracker/dev/twelvedata-api-key" &&
      local.calendar_env.ALPHAVANTAGE_API_KEY_PARAM == "/portfolio-tracker/dev/alphavantage-api-key" &&
      local.calendar_env.EODHD_API_KEY_PARAM == "/portfolio-tracker/dev/eodhd-api-key"
    )
    error_message = "the calendar Lambda needs the prices environment (table, provider, SSM parameter names) plus its budgets"
  }

  assert {
    condition = (
      one(data.aws_iam_policy_document.scheduler_calendar.statement).actions == toset(["lambda:InvokeFunction"]) &&
      aws_iam_role_policy.scheduler_calendar.name == "invoke-prices-calendar"
    )
    error_message = "the shared scheduler role may invoke the calendar Lambda"
  }

  assert {
    condition     = module.prices_refresh_lambda.function_name == "portfolio-tracker-prices-refresh-dev"
    error_message = "the quote refresh keeps its own function"
  }
}

run "calendar_budgets_are_configurable" {
  command = plan

  variables {
    calendar_cron                     = "cron(0 4 * * ? *)"
    calendar_eodhd_daily_calls        = 4
    calendar_alphavantage_daily_calls = 2
    calendar_recheck_days             = 14
    calendar_earnings_horizon         = "6month"
    calendar_timeout                  = 120
    market_data_provider              = "live"
  }

  assert {
    condition = (
      aws_scheduler_schedule.prices_calendar.schedule_expression == "cron(0 4 * * ? *)" &&
      local.calendar_env.CALENDAR_EODHD_DAILY_CALLS == "4" &&
      local.calendar_env.CALENDAR_ALPHAVANTAGE_DAILY_CALLS == "2" &&
      local.calendar_env.CALENDAR_RECHECK_DAYS == "14" &&
      local.calendar_env.CALENDAR_EARNINGS_HORIZON == "6month" &&
      local.calendar_env.MARKET_DATA_PROVIDER == "live"
    )
    error_message = "calendar variables must reach the schedule and the Lambda environment"
  }
}

run "rejects_eodhd_budget_above_the_free_tier" {
  command = plan

  variables {
    calendar_eodhd_daily_calls = 21
  }

  expect_failures = [var.calendar_eodhd_daily_calls]
}

run "rejects_unknown_earnings_horizon" {
  command = plan

  variables {
    calendar_earnings_horizon = "forever"
  }

  expect_failures = [var.calendar_earnings_horizon]
}

run "rejects_too_short_timeout" {
  command = plan

  variables {
    calendar_timeout = 10
  }

  expect_failures = [var.calendar_timeout]
}
