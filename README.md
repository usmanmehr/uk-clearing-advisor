# UK Clearing Advisor

[![Validate CloudFormation](https://github.com/usmanmehr/uk-clearing-advisor/actions/workflows/cfn-lint.yml/badge.svg)](https://github.com/usmanmehr/uk-clearing-advisor/actions/workflows/cfn-lint.yml)

A UK-only, fully serverless web app that helps students find undergraduate
courses in UCAS Clearing, ranked by graduate employability and value for money,
plus a Grafana analytics stack showing where visitors come from.

Built on AWS with CloudFormation (S3, CloudFront, WAF, API Gateway, Lambda,
DynamoDB, EventBridge, CloudWatch, Cognito, EC2 for Grafana).

![Architecture](architecture.png)

## Features
- Search by A-levels + subject interest; ranked shortlist by employability,
  salary, ranking or a balanced score.
- Estimated-data mode when no live UCAS feed is configured (seeded university
  contacts + national subject averages, clearly flagged). Wire the UCAS API for
  true course-level vacancies.
- UK-only access enforced at the edge (CloudFront geo-restriction + AWS WAF).
- Invisible anti-bot: WAF managed rules, per-IP rate limiting, honeypot field.
- PDF/XLSX export, daily change scraper, and Results-Day autoscaling.
- Grafana dashboard (UK visitor map, region/city/device breakdown, security).

## Quickstart - deploy your own
You deploy into your **own** AWS account; all account-specific values are
placeholders you supply.

```bash
REGION=eu-west-2
ACCT=$(aws sts get-caller-identity --query Account --output text)
ART=uk-clearing-advisor-artifacts-$ACCT

# 1. Artifacts bucket + Lambda zips
aws s3 mb s3://$ART --region $REGION
python3 scripts/build_lambdas.py
for f in build/*.zip; do aws s3 cp "$f" s3://$ART/lambda/ --region $REGION; done

# 2. Data + seed, then compute + API
aws cloudformation deploy --template-file stacks/data.yaml \
  --stack-name uk-clearing-advisor-data --region $REGION
python3 scripts/seed.py
aws cloudformation deploy --template-file stacks/compute.yaml \
  --stack-name uk-clearing-advisor-compute --region $REGION \
  --capabilities CAPABILITY_IAM --parameter-overrides ArtifactsBucket=$ART
aws cloudformation deploy --template-file stacks/api.yaml \
  --stack-name uk-clearing-advisor-api --region $REGION
```

That gets the API working. Add the edge, UI and extras (WAF, CDN, frontend,
observability, scaling, Grafana) using the full sequence in "Deploy" below.
Minimum you must supply: unique bucket names, `AdminEmail`, and (for Grafana)
`VpcId` / `SubnetId` / `AllowedCidr`.

## Repository layout
```
stacks/        CloudFormation templates (data, compute, api, cdn, waf,
               observability, scaling, grafana, grafana-front)
lambda/        Node.js 22 handlers (zero external deps; AWS SDK v3 only)
frontend/      Vanilla HTML/CSS/JS static site
scripts/       seed.py (DynamoDB seed), build_lambdas.py (zip packager)
grafana/       Grafana dashboard model
architecture.* Diagram (png/svg) + Graphviz source
ARCHITECTURE.md  Developer reference (stack inventory + change guide)
```

## Prerequisites
- An AWS account and the AWS CLI configured.
- Python 3 (for the seed and packaging scripts). No Node/npm required - the
  Lambdas use only the AWS SDK bundled in the Node.js 22 runtime.
- Graphviz (optional, only to re-render the diagram).

## Configure for your account
These values are account-specific - set them via `--parameter-overrides` (or
edit the parameter defaults):
- Artifacts/exports/site bucket names (must be globally unique).
- `AdminEmail` for CloudWatch alerts.
- `VpcId` / `SubnetId` for the Grafana EC2 instance.
- `AllowedCidr` / WAF IP-set for who may reach Grafana.

No secrets are committed. The Grafana admin password is generated into Secrets
Manager; the CloudFront->origin secret is passed at deploy time.

## Deploy (order matters)
```bash
REGION=eu-west-2
ACCT=$(aws sts get-caller-identity --query Account --output text)
ART=uk-clearing-advisor-artifacts-$ACCT

# 1. Artifacts bucket + Lambda zips
aws s3 mb s3://$ART --region $REGION
python3 scripts/build_lambdas.py
for f in build/*.zip; do aws s3 cp "$f" s3://$ART/lambda/ --region $REGION; done

# 2. Data + seed
aws cloudformation deploy --template-file stacks/data.yaml \
  --stack-name uk-clearing-advisor-data --region $REGION
python3 scripts/seed.py

# 3. Compute, API
aws cloudformation deploy --template-file stacks/compute.yaml \
  --stack-name uk-clearing-advisor-compute --region $REGION \
  --capabilities CAPABILITY_IAM --parameter-overrides ArtifactsBucket=$ART
aws cloudformation deploy --template-file stacks/api.yaml \
  --stack-name uk-clearing-advisor-api --region $REGION

# 4. WAF (us-east-1), then CDN + frontend
aws cloudformation deploy --template-file stacks/waf.yaml \
  --stack-name uk-clearing-advisor-waf --region us-east-1
aws cloudformation deploy --template-file stacks/cdn.yaml \
  --stack-name uk-clearing-advisor-cdn --region $REGION \
  --parameter-overrides WebACLArn=<waf-arn> ApiDomain=<api-host>
aws s3 sync frontend/ s3://<site-bucket>/ --delete --region $REGION

# 5. Optional: observability, scaling, grafana, grafana-front
```
See `ARCHITECTURE.md` for the full stack inventory and a "where to change what"
guide.

## Security notes
- Access is UK-restricted by design. Do not open security groups or WAF to
  `0.0.0.0/0` in production.
- The Grafana front door uses a trusted CloudFront certificate; the EC2 origin
  is HTTP behind a secret header and locked to the CloudFront prefix list.

## Data accuracy
Without a live UCAS feed, results are estimates and status badges are
university-level (labelled as such). Confirm course-level Clearing availability
with the university on Results Day. Integrating the UCAS Clearing API is the
path to authoritative, course-level data.

## Contributing
See [CONTRIBUTING.md](CONTRIBUTING.md). CI runs `cfn-lint` on every push to the
templates.

## Branch protection (recommended)
Protect `main` so changes go through review and CI. On GitHub:
**Settings -> Branches -> Add branch ruleset** (or "Add rule") targeting `main`:
- Require a pull request before merging (at least 1 approval).
- Require status checks to pass -> select **Validate CloudFormation** (cfn-lint),
  and "Require branches to be up to date before merging".
- Block force pushes and branch deletion.
- Optional: require linear history and signed commits.

This keeps the linted, reviewed state on `main` and prevents accidental direct
pushes or force-pushes.

## License
MIT - see [LICENSE](LICENSE).
