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
`price_refresh_cron` (Europe/Amsterdam), `extra_cors_origins`, `enable_auth` (Cognito JWT authorizer),
`alarm_email` (SNS for DLQ alarms), `github_repo` (OIDC deploy role).

`prod` enables DynamoDB / Cognito deletion protection and keeps the imports bucket non-force-destroyable.

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
   (optional: `AWS_REGION`, `ALARM_EMAIL`, `ENABLE_AUTH`, `MARKET_DATA_PROVIDER`).

The deploy role trusts `repo:<repo>:environment:<env>` and `repo:<repo>:ref:refs/heads/main`, and its
permissions are scoped to `portfolio-tracker-*` resources where the AWS APIs allow it.

## 7. Teardown

```bash
terraform destroy -var-file=dev.tfvars
```

For `prod`, deletion protection blocks destroy: first disable it on the DynamoDB table (and Cognito
user pool if `enable_auth`) via the console/CLI, and empty the imports bucket (`aws s3 rm --recursive`).
SSM parameters and log groups are destroyed too.

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
