variable "region" {
  description = "AWS region."
  type        = string
  default     = "eu-west-1"
}

variable "env" {
  description = "Deployment environment."
  type        = string

  validation {
    condition     = contains(["dev", "prod"], var.env)
    error_message = "env must be one of: dev, prod."
  }
}

variable "artifacts_dir" {
  description = "Directory containing services/*/dist/*.zip build artifacts (repo root). Empty = <path.root>/../.."
  type        = string
  default     = ""
}

variable "log_retention_days" {
  description = "CloudWatch log retention for Lambda and API access logs."
  type        = number
  default     = 14
}

variable "log_level" {
  description = "LOG_LEVEL env var for all Lambdas."
  type        = string
  default     = "INFO"
}

variable "base_currency" {
  description = "BASE_CURRENCY env var (api, prices)."
  type        = string
  default     = "EUR"
}

variable "demo_user_id" {
  description = "DEMO_USER_ID env var (api); used when no JWT claim is present."
  type        = string
  default     = "demo"
}

variable "market_data_provider" {
  description = "MARKET_DATA_PROVIDER env var for prices Lambdas (mock | live)."
  type        = string
  default     = "mock"

  validation {
    condition     = contains(["mock", "live"], var.market_data_provider)
    error_message = "market_data_provider must be one of: mock, live."
  }
}

variable "market_data_api_key_params" {
  description = "SSM SecureString parameter base names (created under /portfolio-tracker/<env>/) holding market-data API keys."
  type        = list(string)
  default     = ["twelvedata-api-key", "eodhd-api-key", "coingecko-api-key", "alphavantage-api-key"]

  validation {
    condition     = alltrue([for n in var.market_data_api_key_params : can(regex("^[a-z0-9-]+$", n))])
    error_message = "Parameter names must be lowercase kebab-case (e.g. twelvedata-api-key)."
  }
}

variable "price_refresh_cron" {
  description = "EventBridge Scheduler expression for the prices-refresh Lambda."
  type        = string
  default     = "cron(0 8,13,18,22 ? * MON-FRI *)"
}

variable "price_refresh_timezone" {
  description = "Timezone for price_refresh_cron."
  type        = string
  default     = "Europe/Amsterdam"
}

variable "eu_refresh_hours" {
  description = "EU_REFRESH_HOURS env var for prices-refresh (comma-separated local hours)."
  type        = string
  default     = "18"
}

variable "extra_cors_origins" {
  description = "Additional origins allowed by API Gateway CORS and the imports bucket CORS (e.g. local Vite dev server)."
  type        = list(string)
  default     = ["http://localhost:5173"]
}

variable "enable_auth" {
  description = "Create a Cognito user pool + app client and protect the API with a JWT authorizer."
  type        = bool
  default     = false
}

variable "api_throttle_burst_limit" {
  description = "Default route throttling burst limit."
  type        = number
  default     = 20
}

variable "api_throttle_rate_limit" {
  description = "Default route throttling rate limit (req/s)."
  type        = number
  default     = 10
}

variable "alarm_email" {
  description = "Email address subscribed to DLQ alarms via SNS. Empty = no SNS topic."
  type        = string
  default     = ""
}

variable "github_repo" {
  description = "GitHub repository (owner/name) allowed to assume the deploy role via OIDC. Empty = skip."
  type        = string
  default     = ""

  validation {
    condition     = var.github_repo == "" || can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.github_repo))
    error_message = "github_repo must be empty or in the form owner/repo."
  }
}

variable "create_github_oidc_provider" {
  description = "Create the GitHub OIDC identity provider (set false if it already exists in the account)."
  type        = bool
  default     = true
}
