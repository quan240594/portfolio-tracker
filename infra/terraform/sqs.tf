data "aws_iam_policy_document" "alarms_key" {
  count = var.alarm_email == "" ? 0 : 1

  statement {
    sid       = "EnableAccountAdministration"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:${local.partition}:iam::${local.account_id}:root"]
    }
  }

  # CloudWatch alarms publish to the encrypted topic with the alarm's own (service) identity.
  statement {
    sid       = "AllowCloudWatchAlarmsToPublish"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [local.account_id]
    }
    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:${local.partition}:cloudwatch:${local.region}:${local.account_id}:alarm:*"]
    }
  }
}

# Customer-managed key for the alarms topic (the AWS-managed alias/aws/sns key cannot grant
# cloudwatch.amazonaws.com, which would break alarm delivery).
resource "aws_kms_key" "alarms" {
  count = var.alarm_email == "" ? 0 : 1

  description             = "${local.app} ${var.env} alarms SNS topic encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 7
  policy                  = data.aws_iam_policy_document.alarms_key[0].json
}

resource "aws_kms_alias" "alarms" {
  count = var.alarm_email == "" ? 0 : 1

  name          = "alias/${local.app}-alarms-${var.env}"
  target_key_id = aws_kms_key.alarms[0].key_id
}

resource "aws_sns_topic" "alarms" {
  count             = var.alarm_email == "" ? 0 : 1
  name              = "${local.app}-alarms-${var.env}"
  kms_master_key_id = aws_kms_key.alarms[0].arn
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
