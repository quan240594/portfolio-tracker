output "api_url" {
  description = "HTTP API base URL (use as VITE_API_BASE_URL)."
  value       = aws_apigatewayv2_api.http.api_endpoint
}

output "web_bucket" {
  value = aws_s3_bucket.web.bucket
}

output "cloudfront_domain" {
  value = aws_cloudfront_distribution.web.domain_name
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.web.id
}

output "web_url" {
  value = local.web_origin
}

output "imports_bucket" {
  value = aws_s3_bucket.imports.bucket
}

output "table_name" {
  value = aws_dynamodb_table.main.name
}

output "event_bus_name" {
  value = aws_cloudwatch_event_bus.main.name
}

output "ingest_queue_url" {
  value = module.ingest_queue.queue_url
}

output "enrich_queue_url" {
  value = module.enrich_queue.queue_url
}

output "lambda_function_names" {
  value = {
    api            = module.api_lambda.function_name
    ingest         = module.ingest_lambda.function_name
    prices_refresh = module.prices_refresh_lambda.function_name
    prices_enrich  = module.prices_enrich_lambda.function_name
  }
}

output "market_data_api_key_params" {
  description = "SSM parameter names to populate with real API keys."
  value       = [for p in aws_ssm_parameter.market_data_api_keys : p.name]
}

output "cognito_user_pool_id" {
  value = var.enable_auth ? aws_cognito_user_pool.main[0].id : null
}

output "cognito_user_pool_client_id" {
  value = var.enable_auth ? aws_cognito_user_pool_client.web[0].id : null
}

output "github_deploy_role_arn" {
  value = var.github_repo == "" ? null : aws_iam_role.github_deploy[0].arn
}
