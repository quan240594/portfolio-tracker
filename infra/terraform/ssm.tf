resource "aws_ssm_parameter" "market_data_api_keys" {
  for_each = toset(var.market_data_api_key_params)

  name        = "${local.ssm_prefix}/${each.value}"
  description = "Market-data API key (${each.value}). Set the real value out of band; Terraform ignores changes."
  type        = "SecureString"
  value       = "CHANGE_ME"

  lifecycle {
    ignore_changes = [value]
  }
}
