# portfolio-tracker — Terraform

Single root module (files grouped by concern) plus two local modules:

| Path | Purpose |
|---|---|
| `modules/lambda` | Lambda function + least-privilege role (logs/X-Ray added) + 14-day log group |
| `modules/queue_with_dlq` | SQS queue + DLQ (redrive 3, SSE-SQS, TLS-only policy, EventBridge send permission) + DLQ alarm |
| `dynamodb.tf` `s3.tf` `events.tf` `sqs.tf` `ssm.tf` `iam.tf` `lambda.tf` `scheduler.tf` `apigw.tf` `web.tf` | App resources (see `docs/architecture.md`) |
| `github_oidc.tf` | Optional GitHub Actions OIDC provider + deploy role (`github_repo != ""`) |

Naming follows `docs/architecture.md` (`portfolio-tracker-{component}-{env}`).

## Prerequisites

- Terraform >= 1.6 (CI uses 1.9.x) — or Docker: `docker run --rm -v "$PWD":/w -w /w/infra/terraform hashicorp/terraform:1.9 <cmd>`
- AWS CLI v2 with credentials for the target account
- Node 20 + pnpm, Python 3.12 (to build artifacts)

## 1. Bootstrap remote state (once per account)

```bash
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=eu-west-1
BUCKET=portfolio-tracker-tfstate-$ACCOUNT   # keep the portfolio-tracker- prefix (deploy role is scoped to it)

aws s3api create-bucket --bucket $BUCKET --region $REGION --create-bucket-configuration LocationConstraint=$REGION
aws s3api put-bucket-versioning --bucket $BUCKET --versioning-configuration Status=Enabled
aws s3api put-public-access-block --bucket $BUCKET --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws dynamodb create-table --table-name portfolio-tracker-tflock --region $REGION \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH --billing-mode PAY_PER_REQUEST

cp backend.hcl.example backend-dev.hcl   # edit bucket + key (portfolio-tracker/dev/terraform.tfstate)
terraform init -backend-config=backend-dev.hcl
```

Use a separate backend file / state key per env (`-reconfigure` when switching).

## 2. Build artifacts

Terraform reads the zips listed in `docs/architecture.md` relative to `artifacts_dir`
(default: repo root, `../..`). From the repo root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @portfolio/api package      # services/api/dist/api.zip
pnpm --filter @portfolio/ingest package   # services/ingest/dist/ingest.zip
pnpm --filter @portfolio/broker-sync package   # services/broker-sync/dist/broker-sync.zip (Trading 212 sync, broker.tf)
services/prices/scripts/package.sh        # services/prices/dist/prices.zip
```

`plan` fails with a clear precondition error if an artifact is missing.

## 3. Apply

```bash
cp terraform.tfvars.example dev.tfvars   # *.tfvars are git-ignored
terraform plan  -var-file=dev.tfvars -out=tfplan
terraform apply tfplan
terraform output
```

Key variables: `env` (dev|prod), `market_data_provider` (`mock`|`live`), `market_data_api_key_params`,
`price_refresh_cron` (Europe/Amsterdam), `extra_cors_origins`, `enable_auth` (Cognito JWT authorizer; unset = on for prod,
must be set explicitly for dev, `false` is rejected for prod),
`alarm_email` (SNS for DLQ alarms), `github_repo` (OIDC deploy role).

`prod` enables DynamoDB / Cognito deletion protection and keeps the imports bucket non-force-destroyable.

Access logging: the imports and web buckets log (S3 server access logs) and the CloudFront distribution logs
(standard/legacy logging) to one shared `portfolio-tracker-access-logs-<env>-<account>` bucket (`access_logs.tf`),
under the prefixes `s3/imports/`, `s3/web/` and `cloudfront/web/`. Logs expire after `access_log_retention_days`
(default 90). The alarms SNS topic is encrypted with a customer-managed, auto-rotated KMS key
(`alias/portfolio-tracker-alarms-<env>`) whose key policy lets CloudWatch alarms publish.

## 4. Set market-data API keys

Terraform creates the SecureStrings with value `CHANGE_ME` and ignores later value changes:

```bash
terraform output market_data_api_key_params
aws ssm put-parameter --overwrite --type SecureString \
  --name /portfolio-tracker/dev/twelvedata-api-key --value '<key>'
```

Then set `market_data_provider = "live"` and re-apply.

## 5. Deploy the web app

```bash
API_URL=$(terraform output -raw api_url)
WEB_BUCKET=$(terraform output -raw web_bucket)
DIST_ID=$(terraform output -raw cloudfront_distribution_id)

(cd ../.. && VITE_API_BASE_URL=$API_URL pnpm --filter @portfolio/web build)
aws s3 sync ../../web/dist s3://$WEB_BUCKET --delete
aws cloudfront create-invalidation --distribution-id $DIST_ID --paths '/*'
```

## 6. CI/CD (GitHub Actions)

`.github/workflows/deploy.yml` (manual, `env` input) builds artifacts, runs `terraform apply`,
builds and uploads the web app and invalidates CloudFront, authenticating with GitHub OIDC.

1. Apply once locally with `-var github_repo=<owner>/<repo>`. The OIDC provider is account-wide:
   for the second env in the same account set `create_github_oidc_provider = false`
   (repository/environment variable `CREATE_GITHUB_OIDC_PROVIDER=false`).
2. Create GitHub environments `dev` / `prod` with secret `AWS_DEPLOY_ROLE_ARN`
   (= `terraform output -raw github_deploy_role_arn`) and variables `TF_STATE_BUCKET`, `TF_LOCK_TABLE`
   (optional: `AWS_REGION`, `ALARM_EMAIL`, `ENABLE_AUTH` — defaults to `true`; prod refuses `false` — `MARKET_DATA_PROVIDER`).
   The workflow builds the web app with `VITE_AUTH_MODE` / `VITE_COGNITO_*` taken from the Terraform outputs
   `cognito_user_pool_id`, `cognito_user_pool_client_id`, `cognito_region`.

The deploy role trusts `repo:<repo>:environment:<env>` and `repo:<repo>:ref:refs/heads/main`, and its
permissions are scoped to `portfolio-tracker-*` resources where the AWS APIs allow it.

## 7. Teardown

```bash
terraform destroy -var-file=dev.tfvars
```

For `prod`, deletion protection blocks destroy: first disable it on the DynamoDB table (and Cognito
user pool if `enable_auth`) via the console/CLI, and empty the imports and access-logs buckets (`aws s3 rm --recursive`).
SSM parameters and log groups are destroyed too.

## 8. Users and sign-in (Cognito)

With `enable_auth = true` (default for prod) Terraform creates a Cognito user pool, a SPA app client and a JWT
authorizer on the HTTP API, and runs the API Lambda with `AUTH_MODE=cognito`. The pool has **self sign-up disabled**
(personal app on a public repo) and **mandatory TOTP MFA** (software token only, no SMS).

Create the first user (admin bootstrap, once per environment; the pool id is a Terraform output):

```bash
POOL_ID=$(terraform output -raw cognito_user_pool_id)
aws cognito-idp admin-create-user --user-pool-id "$POOL_ID" --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true \
  --temporary-password 'Temp-Passw0rd!change-me' --message-action SUPPRESS
```

(`--message-action SUPPRESS` skips the invitation email; the temporary password must satisfy the pool policy — 12+
characters with upper/lower case, a number and a symbol — and is valid for 7 days.) Never commit the temporary password.

First sign-in in the web app (`terraform output web_url`):
1. Sign in with the email and temporary password → the app asks for a new password.
2. The app shows a QR code (and a manual key) → add it to an authenticator app (1Password, Google Authenticator, Authy…)
   and enter the 6-digit code. MFA is now enrolled; every later sign-in asks for the code.
3. Lost authenticator? Cognito has no admin call that removes a registered TOTP device, so keep the manual key in a
   password manager (or enrol the same secret on two devices). The fallback is to delete and re-create the user —
   which gets a **new `sub`**, i.e. a new `USER#<sub>` partition: re-key the old items (or note that the old data
   stays under the old `sub`) before deleting.

Forgot password: "Forgot password?" on the sign-in screen sends a code by email (Cognito's default email sender,
~50 emails/day). To force a user out: `aws cognito-idp admin-user-global-sign-out --user-pool-id "$POOL_ID" --username …`.

`terraform test` covers the pool (MFA ON/TOTP only, sign-up disabled, password policy), the authorizer and the
prod preconditions. The Cognito/API Gateway integration itself can only be verified in a real deployment.

## Local development

LocalStack mirrors these resources with `env = local` — see `docker-compose.yml` and
`infra/localstack/init/ready.d/01-bootstrap.sh`. Locally S3 → SQS uses a bucket *notification*
(not EventBridge); the ingest handler accepts both shapes.

## Validation & security scanning

```bash
terraform fmt -recursive -check
terraform init -backend=false && terraform validate
terraform test        # offline plan assertions with a mocked AWS provider (needs artifacts or -var artifacts_dir=...)
tflint --recursive
trivy config .        # accepted findings documented in .trivyignore
```
