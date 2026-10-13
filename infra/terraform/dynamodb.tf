resource "aws_dynamodb_table" "main" {
  name                        = local.name
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "PK"
  range_key                   = "SK"
  deletion_protection_enabled = var.env == "prod"

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  point_in_time_recovery {
    enabled = true
  }

  # AWS managed key (aws/dynamodb).
  server_side_encryption {
    enabled = true
  }
}
