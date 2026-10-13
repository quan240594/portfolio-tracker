resource "aws_cloudwatch_event_bus" "main" {
  name = local.name
}

# Flow 1: S3 "Object Created" (default bus, prefix imports/) -> ingest queue
resource "aws_cloudwatch_event_rule" "import_object_created" {
  name           = "${local.app}-import-created-${var.env}"
  description    = "CSV uploaded to the imports bucket"
  event_bus_name = "default"
  event_pattern = jsonencode({
    source        = ["aws.s3"]
    "detail-type" = ["Object Created"]
    detail = {
      bucket = { name = [aws_s3_bucket.imports.bucket] }
      object = { key = [{ prefix = "imports/" }] }
    }
  })
}

resource "aws_cloudwatch_event_target" "import_object_created" {
  rule           = aws_cloudwatch_event_rule.import_object_created.name
  event_bus_name = "default"
  target_id      = "ingest-queue"
  arn            = module.ingest_queue.queue_arn

  retry_policy {
    maximum_event_age_in_seconds = 3600
    maximum_retry_attempts       = 10
  }
}

# Flow 2: TransactionsChanged (custom bus) -> enrich queue
resource "aws_cloudwatch_event_rule" "transactions_changed" {
  name           = "${local.app}-transactions-changed-${var.env}"
  description    = "Transactions created/deleted/imported"
  event_bus_name = aws_cloudwatch_event_bus.main.name
  event_pattern = jsonencode({
    "detail-type" = ["TransactionsChanged"]
  })
}

resource "aws_cloudwatch_event_target" "transactions_changed" {
  rule           = aws_cloudwatch_event_rule.transactions_changed.name
  event_bus_name = aws_cloudwatch_event_bus.main.name
  target_id      = "enrich-queue"
  arn            = module.enrich_queue.queue_arn

  retry_policy {
    maximum_event_age_in_seconds = 3600
    maximum_retry_attempts       = 10
  }
}
