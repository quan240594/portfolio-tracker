variable "function_name" {
  type = string
}

variable "description" {
  type    = string
  default = ""
}

variable "filename" {
  description = "Path to the deployment zip."
  type        = string
}

variable "handler" {
  type = string
}

variable "runtime" {
  type = string
}

variable "memory_size" {
  type = number
}

variable "timeout" {
  type = number
}

variable "environment" {
  type    = map(string)
  default = {}
}

variable "policy_json" {
  description = "Function-specific IAM policy document (JSON). Logs + X-Ray permissions are added by the module."
  type        = string
}

variable "log_retention_days" {
  type    = number
  default = 14
}
