data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${local.app}-scheduler-${var.env}"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

data "aws_iam_policy_document" "scheduler" {
  statement {
    actions = ["lambda:InvokeFunction"]
    resources = [
      module.prices_refresh_lambda.function_arn,
      "${module.prices_refresh_lambda.function_arn}:*",
    ]
  }
}

resource "aws_iam_role_policy" "scheduler" {
  name   = "invoke-prices-refresh"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler.json
}

resource "aws_scheduler_schedule" "prices_refresh" {
  name                         = "${local.app}-prices-refresh-${var.env}"
  description                  = "Refresh quotes/EOD/FX for tracked tickers"
  schedule_expression          = var.price_refresh_cron
  schedule_expression_timezone = var.price_refresh_timezone

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = module.prices_refresh_lambda.function_arn
    role_arn = aws_iam_role.scheduler.arn
    input    = jsonencode({ trigger = "scheduled" })

    retry_policy {
      maximum_event_age_in_seconds = 3600
      maximum_retry_attempts       = 2
    }
  }
}
