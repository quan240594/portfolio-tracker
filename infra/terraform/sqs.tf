resource "aws_sns_topic" "alarms" {
  count = var.alarm_email == "" ? 0 : 1
  name  = "${local.app}-alarms-${var.env}"
}

resource "aws_sns_topic_subscription" "alarms_email" {
  count     = var.alarm_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alarms[0].arn
  protocol  = "email"
  endpoint  = var.alarm_email
}

module "ingest_queue" {
  source = "./modules/queue_with_dlq"

  name                       = "${local.app}-ingest-${var.env}"
  dlq_name                   = "${local.app}-ingest-dlq-${var.env}"
  visibility_timeout_seconds = 6 * local.lambda_timeouts.ingest
  max_receive_count          = 3
  eventbridge_rule_arns      = [aws_cloudwatch_event_rule.import_object_created.arn]
  alarm_actions              = aws_sns_topic.alarms[*].arn
}

module "enrich_queue" {
  source = "./modules/queue_with_dlq"

  name                       = "${local.app}-enrich-${var.env}"
  dlq_name                   = "${local.app}-enrich-dlq-${var.env}"
  visibility_timeout_seconds = 6 * local.lambda_timeouts.prices_enrich
  max_receive_count          = 3
  eventbridge_rule_arns      = [aws_cloudwatch_event_rule.transactions_changed.arn]
  alarm_actions              = aws_sns_topic.alarms[*].arn
}
