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
  authorization_type = var.enable_auth ? "JWT" : "NONE"
  authorizer_id      = var.enable_auth ? aws_apigatewayv2_authorizer.jwt[0].id : null
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

# ---------------------------------------------------------------------------
# Optional Cognito JWT auth (var.enable_auth)
# ---------------------------------------------------------------------------
resource "aws_cognito_user_pool" "main" {
  count = var.enable_auth ? 1 : 0

  name                     = local.name
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  deletion_protection      = var.env == "prod" ? "ACTIVE" : "INACTIVE"

  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = false
    temporary_password_validity_days = 7
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
}

resource "aws_cognito_user_pool_client" "web" {
  count = var.enable_auth ? 1 : 0

  name                          = "${local.name}-web"
  user_pool_id                  = aws_cognito_user_pool.main[0].id
  generate_secret               = false
  prevent_user_existence_errors = "ENABLED"
  explicit_auth_flows           = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  access_token_validity         = 60
  id_token_validity             = 60
  refresh_token_validity        = 30

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

resource "aws_apigatewayv2_authorizer" "jwt" {
  count = var.enable_auth ? 1 : 0

  api_id           = aws_apigatewayv2_api.http.id
  name             = "cognito"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    issuer   = "https://cognito-idp.${local.region}.amazonaws.com/${aws_cognito_user_pool.main[0].id}"
    audience = [aws_cognito_user_pool_client.web[0].id]
  }
}
