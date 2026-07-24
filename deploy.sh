#!/usr/bin/env bash
# UK Clearing Advisor - one-command deploy.
#
# Deploys the full stack into YOUR OWN AWS account: data -> compute -> api
# -> waf -> cdn -> frontend, then optionally observability, scaling,
# grafana, grafana-front. Handles the manual steps that used to require
# separate commands: fetching/generating the shared secret, building and
# uploading Lambda zips, seeding DynamoDB, and deploying stacks in the
# correct dependency order.
#
# Usage:
#   ./deploy.sh                 deploy core stack (data, compute, api, waf, cdn, frontend)
#   ./deploy.sh --full          also deploy observability, scaling, grafana, grafana-front
#   ./deploy.sh --core-only     same as no args (explicit)
#   ./deploy.sh --skip-seed     skip scripts/seed.py (use if tables are already seeded)
#
# Re-running is safe: `aws cloudformation deploy` is idempotent (no-op if a
# stack has no changes), and re-seeding overwrites the same items with the
# same values.
#
# Prerequisites: see DEPLOY.md.

set -euo pipefail

# ---------- Config (edit or override via env vars before running) ----------
REGION="${REGION:-eu-west-2}"
WAF_REGION="us-east-1"   # WAF for CloudFront + the Grafana front door MUST be us-east-1.
ADMIN_EMAIL="${ADMIN_EMAIL:-}"
GRAFANA_VPC_ID="${GRAFANA_VPC_ID:-}"
GRAFANA_SUBNET_ID="${GRAFANA_SUBNET_ID:-}"
GRAFANA_ALLOWED_CIDR="${GRAFANA_ALLOWED_CIDR:-}"
FULL_DEPLOY=false
SKIP_SEED=false

for arg in "$@"; do
  case "$arg" in
    --full) FULL_DEPLOY=true ;;
    --core-only) FULL_DEPLOY=false ;;
    --skip-seed) SKIP_SEED=true ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

# ---------- Helpers ----------
log()  { echo -e "\n==> $*"; }
fail() { echo "ERROR: $*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "'$1' is required but not installed. See DEPLOY.md prerequisites."
}

# ---------- Preflight ----------
require_cmd aws
require_cmd python3

log "Checking AWS credentials"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) \
  || fail "AWS CLI is not authenticated. Run 'aws configure' or 'aws login' first."
log "Deploying into account $ACCOUNT_ID, region $REGION (WAF stacks in $WAF_REGION)"

ART_BUCKET="uk-clearing-advisor-artifacts-${ACCOUNT_ID}"
SITE_BUCKET="uk-clearing-advisor-site-${ACCOUNT_ID}"

# ---------- 1. Artifacts bucket + Lambda zips ----------
log "Step 1/8: Artifacts bucket + Lambda zips"
if ! aws s3api head-bucket --bucket "$ART_BUCKET" --region "$REGION" 2>/dev/null; then
  aws s3 mb "s3://${ART_BUCKET}" --region "$REGION"
fi
python3 scripts/build_lambdas.py
for f in build/*.zip; do
  aws s3 cp "$f" "s3://${ART_BUCKET}/lambda/" --region "$REGION" --only-show-errors
done
# Also stage the Grafana dashboard model used by the grafana stack's EC2
# UserData (only actually needed for --full, harmless to upload otherwise).
aws s3 cp grafana/dashboard.json "s3://${ART_BUCKET}/grafana/dashboard.json" --region "$REGION" --only-show-errors

# ---------- 2. Data stack + seed ----------
log "Step 2/8: Data stack (DynamoDB tables)"
aws cloudformation deploy \
  --template-file stacks/data.yaml \
  --stack-name uk-clearing-advisor-data \
  --region "$REGION"

if [ "$SKIP_SEED" = false ]; then
  log "Seeding DynamoDB (universities + subject defaults)"
  python3 scripts/seed.py
else
  log "Skipping seed (--skip-seed given)"
fi

# ---------- 3. Compute stack ----------
log "Step 3/8: Compute stack (Lambdas + IAM roles)"
# The shared secret between CloudFront and the API-facing Lambdas
# (X-Origin-Verify). Generated once and reused on every re-deploy by
# reading it back from a live Lambda's config, so re-running this script
# never breaks a previously-working CloudFront<->API link.
EXISTING_SECRET=$(aws lambda get-function-configuration \
  --function-name ClearingAdvisor-GetSubjects \
  --region "$REGION" \
  --query "Environment.Variables.API_ORIGIN_SECRET" \
  --output text 2>/dev/null || echo "")
if [ -z "$EXISTING_SECRET" ] || [ "$EXISTING_SECRET" = "None" ]; then
  API_ORIGIN_SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")
  log "Generated a new API origin secret (first deploy)"
else
  API_ORIGIN_SECRET="$EXISTING_SECRET"
  log "Reusing existing API origin secret from the live GetSubjects function"
fi

aws cloudformation deploy \
  --template-file stacks/compute.yaml \
  --stack-name uk-clearing-advisor-compute \
  --region "$REGION" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    ArtifactsBucket="$ART_BUCKET" \
    ApiOriginSecret="$API_ORIGIN_SECRET"

# ---------- 4. API stack ----------
# Deployed once now with the default (placeholder) CORS AllowOrigin - the
# real CloudFront domain doesn't exist yet (chicken-and-egg with the cdn
# stack, same situation as Grafana below). This does NOT block the app:
# the frontend calls /api/* as a same-origin relative path through
# CloudFront, so browser CORS never applies to normal usage. AllowOrigin
# only matters for someone calling execute-api directly cross-origin, and
# that hardening step is completed after cdn deploys (see below).
log "Step 4/8: API stack (HTTP API + routes)"
aws cloudformation deploy \
  --template-file stacks/api.yaml \
  --stack-name uk-clearing-advisor-api \
  --region "$REGION"

API_ENDPOINT=$(aws cloudformation describe-stacks \
  --stack-name uk-clearing-advisor-api --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue" --output text)
API_DOMAIN="${API_ENDPOINT#https://}"
log "API endpoint: $API_ENDPOINT"

# ---------- 5. WAF (us-east-1) ----------
log "Step 5/8: App WAF (us-east-1, required for CloudFront)"
aws cloudformation deploy \
  --template-file stacks/waf.yaml \
  --stack-name uk-clearing-advisor-waf \
  --region "$WAF_REGION"

WEBACL_ARN=$(aws cloudformation describe-stacks \
  --stack-name uk-clearing-advisor-waf --region "$WAF_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='WebACLArn'].OutputValue" --output text)

# ---------- 6. CDN stack + frontend sync ----------
log "Step 6/8: CDN stack (CloudFront + S3 site/exports)"
aws cloudformation deploy \
  --template-file stacks/cdn.yaml \
  --stack-name uk-clearing-advisor-cdn \
  --region "$REGION" \
  --parameter-overrides \
    WebACLArn="$WEBACL_ARN" \
    ApiDomain="$API_DOMAIN" \
    ApiOriginSecret="$API_ORIGIN_SECRET"

log "Syncing frontend to S3"
aws s3 sync frontend/ "s3://${SITE_BUCKET}/" --delete --region "$REGION" --only-show-errors

DIST_ID=$(aws cloudformation describe-stacks \
  --stack-name uk-clearing-advisor-cdn --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text)
CF_DOMAIN=$(aws cloudformation describe-stacks \
  --stack-name uk-clearing-advisor-cdn --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDomainName'].OutputValue" --output text)

log "Invalidating CloudFront cache"
aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" >/dev/null

log "Tightening API CORS to the real CloudFront domain"
aws cloudformation deploy \
  --template-file stacks/api.yaml \
  --stack-name uk-clearing-advisor-api \
  --region "$REGION" \
  --parameter-overrides AllowOrigin="https://${CF_DOMAIN}"

log "Core deploy complete."
echo "  Site:  https://${CF_DOMAIN}/  (only reachable from the UK - geo-restricted)"
echo "  API:   ${API_ENDPOINT}"

if [ "$FULL_DEPLOY" = false ]; then
  echo
  echo "Ran core deploy only. Re-run with --full to also deploy observability,"
  echo "Results Day scaling, and the Grafana analytics stack."
  exit 0
fi

# ---------- 7. Observability + scaling ----------
log "Step 7/8: Observability + Results Day scaling"
if [ -z "$ADMIN_EMAIL" ]; then
  fail "ADMIN_EMAIL is required for --full (e.g. ADMIN_EMAIL=you@example.com ./deploy.sh --full)"
fi
aws cloudformation deploy \
  --template-file stacks/observability.yaml \
  --stack-name uk-clearing-advisor-observability \
  --region "$REGION" \
  --parameter-overrides AdminEmail="$ADMIN_EMAIL"
echo "  Check your inbox ($ADMIN_EMAIL) and confirm the SNS subscription."

aws cloudformation deploy \
  --template-file stacks/scaling.yaml \
  --stack-name uk-clearing-advisor-scaling \
  --region "$REGION" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides ArtifactsBucket="$ART_BUCKET"

# ---------- 8. Grafana + Grafana front door ----------
log "Step 8/8: Grafana analytics"
if [ -z "$GRAFANA_VPC_ID" ] || [ -z "$GRAFANA_SUBNET_ID" ] || [ -z "$GRAFANA_ALLOWED_CIDR" ]; then
  fail "GRAFANA_VPC_ID, GRAFANA_SUBNET_ID and GRAFANA_ALLOWED_CIDR are required for --full. See DEPLOY.md."
fi

GRAFANA_ORIGIN_SECRET=$(python3 -c "import secrets; print(secrets.token_hex(32))")

# First pass: deploy grafana with a placeholder front-door domain (chicken-
# and-egg - grafana-front needs the Grafana EIP, grafana needs
# grafana-front's CloudFront domain). Fixed by a second deploy below.
aws cloudformation deploy \
  --template-file stacks/grafana.yaml \
  --stack-name uk-clearing-advisor-grafana \
  --region "$REGION" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    VpcId="$GRAFANA_VPC_ID" \
    SubnetId="$GRAFANA_SUBNET_ID" \
    ArtifactsBucket="$ART_BUCKET" \
    AllowedCidr="$GRAFANA_ALLOWED_CIDR" \
    OriginSecret="$GRAFANA_ORIGIN_SECRET"

GRAFANA_EIP=$(aws cloudformation describe-stacks \
  --stack-name uk-clearing-advisor-grafana --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ElasticIP'].OutputValue" --output text)
GRAFANA_ORIGIN_HOST="${GRAFANA_EIP}.nip.io"

aws cloudformation deploy \
  --template-file stacks/grafana-front.yaml \
  --stack-name uk-clearing-advisor-grafana-front \
  --region "$WAF_REGION" \
  --parameter-overrides \
    OriginHost="$GRAFANA_ORIGIN_HOST" \
    AllowIp="$GRAFANA_ALLOWED_CIDR" \
    OriginSecret="$GRAFANA_ORIGIN_SECRET"

GRAFANA_CF_DOMAIN=$(aws cloudformation describe-stacks \
  --stack-name uk-clearing-advisor-grafana-front --region "$WAF_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDomain'].OutputValue" --output text)

log "Redeploying Grafana with the real front-door domain"
aws cloudformation deploy \
  --template-file stacks/grafana.yaml \
  --stack-name uk-clearing-advisor-grafana \
  --region "$REGION" \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    VpcId="$GRAFANA_VPC_ID" \
    SubnetId="$GRAFANA_SUBNET_ID" \
    ArtifactsBucket="$ART_BUCKET" \
    AllowedCidr="$GRAFANA_ALLOWED_CIDR" \
    OriginSecret="$GRAFANA_ORIGIN_SECRET" \
    FrontDomain="$GRAFANA_CF_DOMAIN"

log "Full deploy complete."
echo "  Site:     https://${CF_DOMAIN}/"
echo "  API:      ${API_ENDPOINT}"
echo "  Grafana:  https://${GRAFANA_CF_DOMAIN}/"
echo "  Grafana admin password: in Secrets Manager, ClearingAdvisor-GrafanaAdmin"
echo "  Create a Grafana login: aws cognito-idp admin-create-user --user-pool-id <id> --username <email>"
