variable "name" {
  description = "Main queue name."
  type        = string
}

variable "dlq_name" {
  description = "Dead-letter queue name."
  type        = string
}

variable "visibility_timeout_seconds" {
  description = "Must be >= 6x the consuming Lambda timeout."
  type        = number
}

variable "max_receive_count" {
  type    = number
  default = 3
}

variable "message_retention_seconds" {
  type    = number
  default = 345600 # 4 days
}

variable "dlq_message_retention_seconds" {
  type    = number
  default = 1209600 # 14 days
}

variable "eventbridge_rule_arns" {
  description = "EventBridge rule ARNs allowed to SendMessage to the main queue."
  type        = list(string)
  default     = []
}

variable "alarm_actions" {
  description = "Actions (e.g. SNS topic ARNs) for the DLQ alarm."
  type        = list(string)
  default     = []
}
