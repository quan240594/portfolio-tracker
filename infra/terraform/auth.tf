# Authentication: Amazon Cognito user pool (admin-created users, mandatory TOTP MFA) + API Gateway JWT authorizer.
# The API Lambda runs with AUTH_MODE=cognito whenever auth is enabled and rejects requests without a validated
# `sub` claim (401 UNAUTHENTICATED). AUTH_MODE=demo only exists for local development and non-prod environments
# that explicitly opt out; prod can never be applied without auth.

locals {
  # null (not set) means "on" for prod. Non-prod environments must choose explicitly (see auth_guard).
  auth_enabled = var.enable_auth == null ? var.env == "prod" : var.enable_auth
  auth_mode    = local.auth_enabled ? "cognito" : "demo"
}

resource "terraform_data" "auth_guard" {
  input = local.auth_mode

  lifecycle {
    precondition {
      condition     = var.env == "prod" || var.enable_auth != null
      error_message = "Set enable_auth explicitly (true = Cognito login, false = single demo user without login) for env=${var.env}."
    }

    precondition {
      condition     = var.env != "prod" || local.auth_mode == "cognito"
      error_message = "env=prod must run with Cognito auth (AUTH_MODE=cognito): enable_auth must be true (or unset). The demo user is never allowed in prod."
    }
  }
}

resource "aws_cognito_user_pool" "main" {
  count = local.auth_enabled ? 1 : 0

  name                     = local.name
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  deletion_protection      = var.env == "prod" ? "ACTIVE" : "INACTIVE"

  # Authenticator-app (TOTP) MFA is mandatory for every user; SMS is not configured at all.
  mfa_configuration = "ON"

  software_token_mfa_configuration {
    enabled = true
  }

  username_configuration {
    case_sensitive = false
  }

  # Personal app on a public repository: no self sign-up, users are created by the owner with admin-create-user.
  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 7
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  # Plus-tier threat protection costs extra; the pool has a handful of admin-created users.
  user_pool_add_ons {
    advanced_security_mode = "OFF"
  }
}

resource "aws_cognito_user_pool_client" "web" {
  count = local.auth_enabled ? 1 : 0

  name         = "${local.name}-web"
  user_pool_id = aws_cognito_user_pool.main[0].id

  generate_secret               = false # public SPA client: no secret
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true
  supported_identity_providers  = ["COGNITO"]
  explicit_auth_flows           = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]

  access_token_validity  = 30
  id_token_validity      = 30
  refresh_token_validity = 30
  auth_session_validity  = 5 # minutes to finish a sign-in challenge (new password, TOTP setup/entry)

  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "days"
  }
}

resource "aws_apigatewayv2_authorizer" "jwt" {
  count = local.auth_enabled ? 1 : 0

  api_id           = aws_apigatewayv2_api.http.id
  name             = "cognito"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    issuer   = "https://cognito-idp.${local.region}.amazonaws.com/${aws_cognito_user_pool.main[0].id}"
    audience = [aws_cognito_user_pool_client.web[0].id]
  }
}
