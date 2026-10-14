#!/usr/bin/env bash
# LocalStack bootstrap: creates the local equivalents of the Terraform-managed resources.
# Runs automatically as a LocalStack ready.d init hook (uses `awslocal`), and can also be run
# from the host/CI against a running LocalStack: set AWS_ENDPOINT_URL (default
# http://localhost:4566) to use `aws --endpoint-url` instead of `awslocal`.
# Idempotent: safe to run repeatedly.
set -euo pipefail

ENV_NAME="local"
APP="portfolio-tracker"
REGION="${AWS_DEFAULT_REGION:-${AWS_REGION:-eu-west-1}}"
ENDPOINT="${AWS_ENDPOINT_URL:-http://localhost:4566}"

TABLE="${APP}-${ENV_NAME}"
BUCKET="${APP}-imports-${ENV_NAME}"
BUS="${APP}-${ENV_NAME}"
INGEST_Q="${APP}-ingest-${ENV_NAME}"
INGEST_DLQ="${APP}-ingest-dlq-${ENV_NAME}"
ENRICH_Q="${APP}-enrich-${ENV_NAME}"
ENRICH_DLQ="${APP}-enrich-dlq-${ENV_NAME}"
RULE="${APP}-transactions-changed-${ENV_NAME}"
CORS_ORIGINS='"http://localhost:5173","http://localhost:5174"'
API_KEY_PARAMS=(twelvedata-api-key eodhd-api-key coingecko-api-key alphavantage-api-key)

if [[ -z "${AWS_ENDPOINT_URL:-}" ]] && command -v awslocal >/dev/null 2>&1 && awslocal --version >/dev/null 2>&1; then
  aws_() { awslocal --region "$REGION" "$@"; }
else
  export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}" AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}"
  aws_() { aws --endpoint-url "$ENDPOINT" --region "$REGION" "$@"; }
fi
export AWS_PAGER=""

log() { echo "[bootstrap] $*"; }

# --- DynamoDB -----------------------------------------------------------------
if aws_ dynamodb describe-table --table-name "$TABLE" >/dev/null 2>&1; then
  log "table $TABLE exists"
else
  aws_ dynamodb create-table \
    --table-name "$TABLE" \
    --attribute-definitions AttributeName=PK,AttributeType=S AttributeName=SK,AttributeType=S \
    --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST >/dev/null
  aws_ dynamodb wait table-exists --table-name "$TABLE"
  log "created table $TABLE"
fi

# --- SQS (DLQs first) -----------------------------------------------------------
ensure_queue() { # name visibility_timeout -> echoes queue url
  local name="$1" vt="$2" url
  url="$(aws_ sqs get-queue-url --queue-name "$name" --query QueueUrl --output text 2>/dev/null || true)"
  if [[ -z "$url" || "$url" == "None" ]]; then
    url="$(aws_ sqs create-queue --queue-name "$name" --query QueueUrl --output text)"
    log "created queue $name" >&2
  fi
  aws_ sqs set-queue-attributes --queue-url "$url" --attributes "VisibilityTimeout=$vt" >/dev/null
  echo "$url"
}
queue_arn() { # queue_url -> echoes queue arn
  local queue_url="$1"
  aws_ sqs get-queue-attributes --queue-url "$queue_url" --attribute-names QueueArn --query Attributes.QueueArn --output text
}
set_redrive() { # queue_url dlq_arn
  local queue_url="$1" dlq_arn="$2"
  aws_ sqs set-queue-attributes --queue-url "$queue_url" \
    --attributes "{\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"$dlq_arn\\\",\\\"maxReceiveCount\\\":\\\"3\\\"}\"}" >/dev/null
}
set_policy() { # queue_url queue_arn service source_arn
  local queue_url="$1" target_arn="$2" service="$3" source_arn="$4" policy
  policy="{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"$service\"},\"Action\":\"sqs:SendMessage\",\"Resource\":\"$target_arn\",\"Condition\":{\"ArnEquals\":{\"aws:SourceArn\":\"$source_arn\"}}}]}"
  policy="${policy//\"/\\\"}"
  aws_ sqs set-queue-attributes --queue-url "$queue_url" --attributes "{\"Policy\":\"$policy\"}" >/dev/null
}

INGEST_DLQ_URL="$(ensure_queue "$INGEST_DLQ" 30)"
ENRICH_DLQ_URL="$(ensure_queue "$ENRICH_DLQ" 30)"
INGEST_Q_URL="$(ensure_queue "$INGEST_Q" 360)"
ENRICH_Q_URL="$(ensure_queue "$ENRICH_Q" 720)"
INGEST_Q_ARN="$(queue_arn "$INGEST_Q_URL")"
ENRICH_Q_ARN="$(queue_arn "$ENRICH_Q_URL")"
set_redrive "$INGEST_Q_URL" "$(queue_arn "$INGEST_DLQ_URL")"
set_redrive "$ENRICH_Q_URL" "$(queue_arn "$ENRICH_DLQ_URL")"
log "queues ready: $INGEST_Q, $ENRICH_Q (+ DLQs)"

# --- S3 imports bucket ----------------------------------------------------------
if aws_ s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then
  log "bucket $BUCKET exists"
else
  aws_ s3api create-bucket --bucket "$BUCKET" \
    --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  log "created bucket $BUCKET"
fi
aws_ s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration "{
  \"CORSRules\": [{
    \"AllowedOrigins\": [$CORS_ORIGINS],
    \"AllowedMethods\": [\"PUT\", \"GET\"],
    \"AllowedHeaders\": [\"Content-Type\"],
    \"ExposeHeaders\": [\"ETag\"],
    \"MaxAgeSeconds\": 3000
  }]
}"

# S3 -> SQS notification (S3 notification shape locally; EventBridge shape in AWS).
set_policy "$INGEST_Q_URL" "$INGEST_Q_ARN" "s3.amazonaws.com" "arn:aws:s3:::$BUCKET"
aws_ s3api put-bucket-notification-configuration --bucket "$BUCKET" --notification-configuration "{
  \"QueueConfigurations\": [{
    \"Id\": \"imports-to-ingest\",
    \"QueueArn\": \"$INGEST_Q_ARN\",
    \"Events\": [\"s3:ObjectCreated:*\"],
    \"Filter\": {\"Key\": {\"FilterRules\": [{\"Name\": \"prefix\", \"Value\": \"imports/\"}]}}
  }]
}"
log "bucket CORS + notification -> $INGEST_Q configured"

# --- EventBridge ----------------------------------------------------------------
if aws_ events describe-event-bus --name "$BUS" >/dev/null 2>&1; then
  log "event bus $BUS exists"
else
  aws_ events create-event-bus --name "$BUS" >/dev/null
  log "created event bus $BUS"
fi
RULE_ARN="$(aws_ events put-rule --name "$RULE" --event-bus-name "$BUS" \
  --event-pattern '{"detail-type":["TransactionsChanged"]}' --query RuleArn --output text)"
set_policy "$ENRICH_Q_URL" "$ENRICH_Q_ARN" "events.amazonaws.com" "$RULE_ARN"
aws_ events put-targets --rule "$RULE" --event-bus-name "$BUS" \
  --targets "Id=enrich-queue,Arn=$ENRICH_Q_ARN" >/dev/null
log "rule $RULE -> $ENRICH_Q configured"

# --- SSM (market-data API keys; never overwrite an existing value) --------------
for p in "${API_KEY_PARAMS[@]}"; do
  name="/${APP}/${ENV_NAME}/${p}"
  if aws_ ssm get-parameter --name "$name" >/dev/null 2>&1; then
    log "ssm $name exists"
  else
    aws_ ssm put-parameter --name "$name" --type SecureString --value "local-dummy" >/dev/null
    log "created ssm $name"
  fi
done

log "done"
