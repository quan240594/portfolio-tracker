# Optional GitHub Actions OIDC deploy role (enabled when var.github_repo != "").
# Bootstrap: apply once locally with -var github_repo=owner/repo, then store the
# `github_deploy_role_arn` output as the AWS_DEPLOY_ROLE_ARN repository/environment secret.

locals {
  github_enabled  = var.github_repo != ""
  github_oidc_url = "token.actions.githubusercontent.com"
  github_oidc_provider_arn = local.github_enabled ? (
    var.create_github_oidc_provider
    ? aws_iam_openid_connect_provider.github[0].arn
    : "arn:${local.partition}:iam::${local.account_id}:oidc-provider/${local.github_oidc_url}"
  ) : ""
  # Everything Terraform manages in this stack is prefixed with the app name.
  app_prefix = "${local.app}-*"
}

resource "aws_iam_openid_connect_provider" "github" {
  count = local.github_enabled && var.create_github_oidc_provider ? 1 : 0

  url            = "https://${local.github_oidc_url}"
  client_id_list = ["sts.amazonaws.com"]
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
  ]
}

data "aws_iam_policy_document" "github_assume" {
  count = local.github_enabled ? 1 : 0

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_url}:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "${local.github_oidc_url}:sub"
      values = [
        "repo:${var.github_repo}:environment:${var.env}",
        "repo:${var.github_repo}:ref:refs/heads/main",
      ]
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  count = local.github_enabled ? 1 : 0

  name                 = "${local.app}-github-deploy-${var.env}"
  assume_role_policy   = data.aws_iam_policy_document.github_assume[0].json
  max_session_duration = 3600
}

data "aws_iam_policy_document" "github_deploy" {
  count = local.github_enabled ? 1 : 0

  # Terraform state + lock table + app buckets (state bucket must be named portfolio-tracker-*).
  statement {
    sid     = "S3AppBuckets"
    actions = ["s3:*"]
    resources = [
      "arn:${local.partition}:s3:::${local.app_prefix}",
      "arn:${local.partition}:s3:::${local.app_prefix}/*",
    ]
  }

  # CMK for the alarms SNS topic. Key ids are generated, so key-level actions cannot be pinned to a name;
  # aliases are scoped to the app prefix.
  statement {
    sid = "KmsAppKeys"
    actions = [
      "kms:CreateAlias",
      "kms:UpdateAlias",
      "kms:DeleteAlias",
      "kms:GetKeyPolicy",
      "kms:PutKeyPolicy",
      "kms:GetKeyRotationStatus",
      "kms:EnableKeyRotation",
      "kms:DisableKeyRotation",
      "kms:ListResourceTags",
      "kms:TagResource",
      "kms:UntagResource",
      "kms:ScheduleKeyDeletion",
      "kms:CancelKeyDeletion",
    ]
    resources = [
      "arn:${local.partition}:kms:${local.region}:${local.account_id}:alias/${local.app_prefix}",
      "arn:${local.partition}:kms:${local.region}:${local.account_id}:key/*",
    ]
  }

  statement {
    sid       = "DynamoDB"
    actions   = ["dynamodb:*"]
    resources = ["arn:${local.partition}:dynamodb:${local.region}:${local.account_id}:table/${local.app_prefix}"]
  }

  statement {
    sid     = "AppServices"
    actions = ["sqs:*", "events:*", "scheduler:*", "lambda:*", "ssm:*", "sns:*"]
    resources = [
      "arn:${local.partition}:sqs:${local.region}:${local.account_id}:${local.app_prefix}",
      "arn:${local.partition}:events:${local.region}:${local.account_id}:event-bus/${local.app_prefix}",
      "arn:${local.partition}:events:${local.region}:${local.account_id}:rule/${local.app_prefix}",
      "arn:${local.partition}:events:${local.region}:${local.account_id}:rule/*/${local.app_prefix}",
      "arn:${local.partition}:scheduler:${local.region}:${local.account_id}:schedule/*/${local.app_prefix}",
      "arn:${local.partition}:lambda:${local.region}:${local.account_id}:function:${local.app_prefix}",
      "arn:${local.partition}:ssm:${local.region}:${local.account_id}:parameter/${local.app}/*",
      "arn:${local.partition}:sns:${local.region}:${local.account_id}:${local.app_prefix}",
    ]
  }

  # Services whose APIs don't support resource-level scoping well (list/describe/create calls,
  # event source mappings, API Gateway, CloudFront, Cognito, CloudWatch alarms, logs).
  statement {
    sid = "UnscopedServices"
    actions = [
      "apigateway:*",
      "cloudfront:*",
      "cognito-idp:*",
      "cloudwatch:*",
      "logs:*",
      "lambda:CreateEventSourceMapping",
      "lambda:GetEventSourceMapping",
      "lambda:UpdateEventSourceMapping",
      "lambda:DeleteEventSourceMapping",
      "lambda:ListEventSourceMappings",
      "sqs:ListQueues",
      "events:ListRules",
      "scheduler:ListSchedules",
      "ssm:DescribeParameters",
      "s3:ListAllMyBuckets",
      "dynamodb:ListTables",
      "dynamodb:DescribeLimits",
      "kms:DescribeKey",
      "kms:CreateKey",
      "kms:ListAliases",
      "sts:GetCallerIdentity",
    ]
    resources = ["*"]
  }

  statement {
    sid = "IamAppRoles"
    actions = [
      "iam:GetRole",
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:UpdateRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:ListRolePolicies",
      "iam:ListAttachedRolePolicies",
      "iam:ListInstanceProfilesForRole",
      "iam:GetRolePolicy",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:PassRole",
    ]
    resources = ["arn:${local.partition}:iam::${local.account_id}:role/${local.app_prefix}"]
  }

  statement {
    sid = "IamOidcProvider"
    actions = [
      "iam:GetOpenIDConnectProvider",
      "iam:CreateOpenIDConnectProvider",
      "iam:DeleteOpenIDConnectProvider",
      "iam:UpdateOpenIDConnectProviderThumbprint",
      "iam:TagOpenIDConnectProvider",
      "iam:UntagOpenIDConnectProvider",
    ]
    resources = ["arn:${local.partition}:iam::${local.account_id}:oidc-provider/${local.github_oidc_url}"]
  }
}

resource "aws_iam_role_policy" "github_deploy" {
  count = local.github_enabled ? 1 : 0

  name   = "terraform-deploy"
  role   = aws_iam_role.github_deploy[0].id
  policy = data.aws_iam_policy_document.github_deploy[0].json
}
