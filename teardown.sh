#!/usr/bin/env bash
# UK Clearing Advisor - full teardown to near-zero cost.
#
# Deletes every CloudFormation stack this project creates, in the correct
# reverse-dependency order. Reference data survives: UniversityContacts,
# Scholarships, SubjectDefaults, and CUGRankings all have
# DeletionPolicy: Retain in stacks/data.yaml, so those 4 DynamoDB tables
# are NOT deleted even though the data stack itself is deleted. Everything
# else (caches, rate limits, change log) is disposable/regenerable and is
# deleted along with the data stack.
#
# To bring everything back later: ./deploy.sh --full (see README.md /
# DEPLOY.md for the required environment variables). The 4 retained
# tables are picked straight back up by name - no re-seeding needed for
# them, though scripts/seed.py is safe to re-run regardless (idempotent
# overwrite of the same items).
#
# This is destructive for everything except the 4 retained tables. Read
# through it before running. Not run automatically - run it yourself
# when you're ready to tear down (e.g. `./teardown.sh`).
#
# Usage:
#   ./teardown.sh            interactive - asks for a final Y/n confirmation
#   ./teardown.sh --yes      skips the confirmation prompt

set -euo pipefail

REGION="${REGION:-eu-west-2}"
WAF_REGION="us-east-1"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
SITE_BUCKET="uk-clearing-advisor-site-${ACCOUNT_ID}"
EXPORTS_BUCKET="uk-clearing-advisor-exports-${ACCOUNT_ID}"
ARTIFACTS_BUCKET="uk-clearing-advisor-artifacts-${ACCOUNT_ID}"

SKIP_CONFIRM=false
for arg in "$@"; do
  case "$arg" in
    --yes) SKIP_CONFIRM=true ;;
  esac
done

log()  { echo -e "\n==> $*"; }

if [ "$SKIP_CONFIRM" = false ]; then
  echo "This will delete ALL uk-clearing-advisor CloudFormation stacks"
  echo "(grafana-front, grafana, scaling, observability, cdn, waf, api,"
  echo "compute, patching, data) in account ${ACCOUNT_ID}."
  echo
  echo "The 4 Retain-tagged DynamoDB tables (UniversityContacts,"
  echo "Scholarships, SubjectDefaults, CUGRankings) will survive."
  echo "Everything else - including the Grafana EC2 instance, its EIP,"
  echo "both WAF Web ACLs, CloudFront distributions, and disposable cache"
  echo "tables - will be permanently deleted."
  echo
  read -rp "Type 'delete' to proceed: " CONFIRM
  [ "$CONFIRM" = "delete" ] || { echo "Aborted."; exit 1; }
fi

delete_stack() {
  local stack="$1" region="$2"
  if aws cloudformation describe-stacks --stack-name "$stack" --region "$region" >/dev/null 2>&1; then
    log "Deleting stack: $stack ($region)"
    aws cloudformation delete-stack --stack-name "$stack" --region "$region"
    aws cloudformation wait stack-delete-complete --stack-name "$stack" --region "$region"
    log "  Deleted."
  else
    log "Stack $stack not found in $region - skipping."
  fi
}

empty_bucket() {
  local bucket="$1"
  if aws s3api head-bucket --bucket "$bucket" --region "$REGION" 2>/dev/null; then
    log "Emptying bucket: $bucket"
    aws s3 rm "s3://${bucket}" --recursive --region "$REGION" 2>/dev/null || true
  fi
}

# ---------- 1. Grafana front door (us-east-1) ----------
delete_stack uk-clearing-advisor-grafana-front "$WAF_REGION"

# ---------- 2. Grafana (EC2 + EIP + Cognito + Secrets Manager) ----------
delete_stack uk-clearing-advisor-grafana "$REGION"

# ---------- 3. Results Day scaling ----------
delete_stack uk-clearing-advisor-scaling "$REGION"

# ---------- 4. Observability (dashboards, alarms, SNS) ----------
delete_stack uk-clearing-advisor-observability "$REGION"

# ---------- 5. Patching (SSM baseline/maintenance window) ----------
delete_stack uk-clearing-advisor-patching "$REGION"

# ---------- 6. CDN (must empty S3 buckets first) ----------
empty_bucket "$SITE_BUCKET"
empty_bucket "$EXPORTS_BUCKET"
delete_stack uk-clearing-advisor-cdn "$REGION"

# ---------- 7. App WAF (us-east-1) - after CDN so nothing still references it ----------
delete_stack uk-clearing-advisor-waf "$WAF_REGION"

# ---------- 8. API (HTTP API + routes) ----------
delete_stack uk-clearing-advisor-api "$REGION"

# ---------- 9. Compute (Lambdas + IAM roles) ----------
delete_stack uk-clearing-advisor-compute "$REGION"

# ---------- 10. Data (DynamoDB) - Retain tables survive automatically ----------
delete_stack uk-clearing-advisor-data "$REGION"

# ---------- Artifacts bucket - not a CFN stack, just an S3 bucket deploy.sh creates ----------
empty_bucket "$ARTIFACTS_BUCKET"
if aws s3api head-bucket --bucket "$ARTIFACTS_BUCKET" --region "$REGION" 2>/dev/null; then
  log "Deleting artifacts bucket: $ARTIFACTS_BUCKET"
  aws s3 rb "s3://${ARTIFACTS_BUCKET}" --region "$REGION"
fi

log "Teardown complete."
echo
echo "Retained (survived teardown):"
aws dynamodb list-tables --region "$REGION" --query "TableNames[?starts_with(@, 'ClearingAdvisor')]" --output table
echo
echo "To bring everything back: ./deploy.sh --full"
echo "(see README.md / DEPLOY.md for required environment variables -"
echo " ADMIN_EMAIL, GRAFANA_VPC_ID, GRAFANA_SUBNET_ID, GRAFANA_ALLOWED_CIDR)"
