resource "aws_apigatewayv2_api" "http" {
  name          = "${local.app}-api-${var.env}"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins  = local.cors_origins
    allow_methods  = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    allow_headers  = ["authorization", "content-type"]
    expose_headers = ["content-type"]
    max_age        = 3600
  }
}

resource "aws_apigatewayv2_integration" "api" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = module.api_lambda.invoke_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 12000
}

resource "aws_apigatewayv2_route" "default" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "$default"
  target             = "integrations/${aws_apigatewayv2_integration.api.id}"
  authorization_type = local.auth_enabled ? "JWT" : "NONE"
  authorizer_id      = local.auth_enabled ? aws_apigatewayv2_authorizer.jwt[0].id : null
}

resource "aws_cloudwatch_log_group" "api_access" {
  name              = "/aws/apigateway/${local.app}-api-${var.env}"
  retention_in_days = var.log_retention_days
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = var.api_throttle_burst_limit
    throttling_rate_limit  = var.api_throttle_rate_limit
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_access.arn
    format = jsonencode({
      requestId          = "$context.requestId"
      ip                 = "$context.identity.sourceIp"
      requestTime        = "$context.requestTime"
      httpMethod         = "$context.httpMethod"
      path               = "$context.path"
      routeKey           = "$context.routeKey"
      status             = "$context.status"
      protocol           = "$context.protocol"
      responseLength     = "$context.responseLength"
      latencyMs          = "$context.responseLatency"
      integrationLatency = "$context.integrationLatency"
      integrationError   = "$context.integrationErrorMessage"
      authorizerError    = "$context.authorizer.error"
    })
  }
}

resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowHttpApiInvoke"
  action        = "lambda:InvokeFunction"
  function_name = module.api_lambda.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*"
}
