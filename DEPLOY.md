# Deploying UK Clearing Advisor

This guide gets you from a fresh AWS account to a working, UK-only Clearing
advisor site using one script: `deploy.sh`. You deploy into your **own** AWS
account - nothing here is shared or multi-tenant.

## What you get

- **Core deploy** (default): the public site + API. Search, subjects,
  universities, scholarships, export, health check. UK-only via CloudFront
  geo-restriction + AWS WAF.
- **Full deploy** (`--full`): adds CloudWatch alarms/dashboards + email
  alerts, Results-Day auto-scaling, and a Grafana analytics dashboard on
  EC2.

## 1. Prerequisites

| Requirement | Why | Check |
|---|---|---|
| An AWS account | You deploy into your own account, nothing is shared | - |
| AWS CLI v2, configured | Every deploy step uses it | `aws --version` (need 2.x), `aws sts get-caller-identity` |
| Python 3.8+ | Packages Lambda zips, seeds DynamoDB, generates secrets | `python3 --version` |
| Bash | Runs `deploy.sh` | macOS/Linux have it; on Windows use WSL or Git Bash |
| An IAM identity with broad permissions | The deploy creates Lambda, DynamoDB, API Gateway, CloudFront, WAF, IAM roles, S3, EventBridge, CloudWatch, SNS resources | Easiest: an Admin-equivalent role for first deploy, tighten later |

You do **not** need Node.js/npm - the Lambda functions use only the AWS SDK
v3 that's bundled into the Lambda Node.js 22 runtime, and are packaged with
a small Python script instead.

You do **not** need Graphviz unless you want to re-render `architecture.png`
after changing `architecture.dot`.

### Get AWS credentials

If you don't already have credentials configured:

```bash
aws configure          # access key + secret, if you use long-term keys
# or, for CLI v2.32+, short-term auto-rotating credentials:
aws login
```

Verify:
```bash
aws sts get-caller-identity
```
This must succeed before running `deploy.sh` - the script checks it first
and fails fast with a clear message if it doesn't.

## 2. Region

Everything deploys to **eu-west-2** (London) by default - this is a UK-only
app, so that's the sensible default. Two things are pinned to **us-east-1**
regardless of your chosen region, because AWS requires it:
- The WAF WebACL used by CloudFront (WAF for CloudFront must be global/`us-east-1`).
- The Grafana front-door WAF + CloudFront (same reason, only needed for `--full`).

You can change the app region via `REGION=eu-west-1 ./deploy.sh` etc., but
us-east-1 for the two WAF stacks is not configurable - it's an AWS platform
requirement, not a script limitation.

## 3. Core deploy (site + API)

```bash
git clone https://github.com/usmanmehr/uk-clearing-advisor.git
cd uk-clearing-advisor
./deploy.sh
```

That's it. The script will, in order:
1. Create an artifacts S3 bucket and upload the packaged Lambda zips.
2. Deploy the `data` stack (8 DynamoDB tables) and seed it with 44
   universities + national subject-average data.
3. Deploy `compute` (Lambda functions + IAM roles), generating a random
   shared secret used between CloudFront and the API on first run (and
   safely reusing the same one on every re-run, so re-deploying never
   breaks a working site).
4. Deploy `api` (the HTTP API + routes).
5. Deploy `waf` in us-east-1 (the CloudFront WebACL).
6. Deploy `cdn` (CloudFront + the S3 static site + exports bucket), sync
   the frontend files to S3, and invalidate the CloudFront cache.

At the end it prints your live site URL and API endpoint. The site is only
reachable from UK IP addresses (by design) - if you're testing from outside
the UK, use a UK VPN or proxy, or you'll see a 403 geo-blocked page.

Takes roughly 10-15 minutes on a first run (CloudFront distributions are the
slowest part, typically 5-10 minutes to fully propagate).

## 4. Full deploy (adds monitoring, scaling, Grafana)

Set a few extra environment variables first, then re-run with `--full`:

```bash
export ADMIN_EMAIL=you@example.com
export GRAFANA_VPC_ID=vpc-xxxxxxxx
export GRAFANA_SUBNET_ID=subnet-xxxxxxxx
export GRAFANA_ALLOWED_CIDR=203.0.113.4/32   # your IP, for direct Grafana access
./deploy.sh --full
```

| Variable | What it's for | How to find it |
|---|---|---|
| `ADMIN_EMAIL` | Where CloudWatch alarm emails go | Any email you can check |
| `GRAFANA_VPC_ID` | VPC to launch the Grafana EC2 instance into | `aws ec2 describe-vpcs --query "Vpcs[].VpcId"` (use your account's default VPC if unsure) |
| `GRAFANA_SUBNET_ID` | A **public** subnet in that VPC (needs an Elastic IP) | `aws ec2 describe-subnets --filters Name=vpc-id,Values=<vpc-id> --query "Subnets[].SubnetId"` |
| `GRAFANA_ALLOWED_CIDR` | Your IP, allowed to reach Grafana directly over HTTPS as an admin fallback (UK visitors reach it via CloudFront instead) | `curl -s ifconfig.me` then append `/32` |

Because `--full` also runs the core steps, running `./deploy.sh --full`
directly (without deploying core first) works too - it does everything in
one go.

After a full deploy:
- **Confirm the SNS email subscription** - check your inbox for a
  "Subscription Confirmation" email from AWS and click confirm, or alarms
  will never actually reach you.
- **Create a Grafana login** (Grafana itself doesn't have self-signup):
  ```bash
  aws cognito-idp admin-create-user \
    --user-pool-id <UserPoolId from the grafana stack output> \
    --username you@example.com
  ```
- The Grafana **admin** password (fallback login, not the OAuth one) is in
  Secrets Manager under `ClearingAdvisor-GrafanaAdmin`.

## 5. Re-running / updating

`deploy.sh` is safe to re-run any time you pull new changes - `aws
cloudformation deploy` only touches what actually changed, and the shared
secrets are reused rather than regenerated. If you only changed Lambda code
(not templates), you still need a fresh `deploy.sh` run: it rebuilds and
re-uploads the zips as part of Step 1, and `aws cloudformation deploy`
picks up the new S3 object automatically.

If you only changed the frontend (`frontend/*`), you don't need a full
re-run - just:
```bash
aws s3 sync frontend/ s3://uk-clearing-advisor-site-<your-account-id>/ --delete
aws cloudfront create-invalidation --distribution-id <dist-id> --paths "/*"
```

## 6. Tearing it down

Stacks depend on each other, so delete in **reverse** order of creation.
Empty the S3 buckets first (CloudFormation won't delete a non-empty bucket).

```bash
ACCT=$(aws sts get-caller-identity --query Account --output text)

# Only if you did a --full deploy:
aws cloudformation delete-stack --stack-name uk-clearing-advisor-grafana-front --region us-east-1
aws cloudformation delete-stack --stack-name uk-clearing-advisor-grafana --region eu-west-2
aws cloudformation delete-stack --stack-name uk-clearing-advisor-scaling --region eu-west-2
aws cloudformation delete-stack --stack-name uk-clearing-advisor-observability --region eu-west-2

# Core stack:
aws s3 rm "s3://uk-clearing-advisor-site-${ACCT}" --recursive
aws s3 rm "s3://uk-clearing-advisor-exports-${ACCT}" --recursive
aws cloudformation delete-stack --stack-name uk-clearing-advisor-cdn --region eu-west-2
aws cloudformation delete-stack --stack-name uk-clearing-advisor-waf --region us-east-1
aws cloudformation delete-stack --stack-name uk-clearing-advisor-api --region eu-west-2
aws cloudformation delete-stack --stack-name uk-clearing-advisor-compute --region eu-west-2

# Data tables use DeletionPolicy: Retain on the reference tables
# (UniversityContacts, SubjectDefaults, Scholarships, CUGRankings) -
# deleting the stack leaves those tables behind on purpose. Delete manually
# if you actually want them gone:
aws cloudformation delete-stack --stack-name uk-clearing-advisor-data --region eu-west-2
aws dynamodb delete-table --table-name ClearingAdvisor-UniversityContacts --region eu-west-2
aws dynamodb delete-table --table-name ClearingAdvisor-SubjectDefaults --region eu-west-2
aws dynamodb delete-table --table-name ClearingAdvisor-Scholarships --region eu-west-2
aws dynamodb delete-table --table-name ClearingAdvisor-CUGRankings --region eu-west-2

# Finally, the artifacts bucket:
aws s3 rm "s3://uk-clearing-advisor-artifacts-${ACCT}" --recursive
aws s3 rb "s3://uk-clearing-advisor-artifacts-${ACCT}"
```

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `AWS CLI is not authenticated` | No credentials configured, or they expired | `aws configure` or `aws login`, then retry |
| `cloudformation deploy` hangs on the CDN stack | CloudFront distributions genuinely take 5-15 min to deploy | Wait - this is normal, not a failure |
| Site loads for you locally but not "in general" | Geo-restriction - the app is UK-only by design | Test from inside the UK, or via a UK VPN/proxy |
| `ROLLBACK_COMPLETE` on any stack | A parameter or resource conflict; check the actual reason | `aws cloudformation describe-stack-events --stack-name <name> --query "StackEvents[?contains(ResourceStatus,'FAILED')]"` |
| Grafana `--full` deploy fails at the subnet step | Subnet isn't public (no route to an internet gateway) | Pick a public subnet, or add a route table entry |
| Re-running `deploy.sh` seems to "undo" my manual console changes | CloudFormation reconciles drift back to what's in the templates | Make changes in the `.yaml` templates, not the console, if you want them to persist |

## More detail

- `ARCHITECTURE.md` - full stack inventory and "I want to change X -> edit
  here" guide for ongoing development.
- `CONTRIBUTING.md` - if you want to contribute changes back.
- `architecture.png` / `architecture.svg` - visual diagram (source:
  `architecture.dot`, Graphviz).
