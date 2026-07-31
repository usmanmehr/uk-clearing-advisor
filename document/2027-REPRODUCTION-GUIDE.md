# UK Clearing Advisor - 2027 Reproduction & Retrospective Guide

**Prepared by:** Cross-functional review (Solutions Architect, Security
Engineer, Lead Developer, End User perspectives)
**Audience:** The team executing the 2027 Results Day rollout
**Status:** Living document - update it as the 2027 deploy actually
happens, don't just read it once and discard it

---

## How to use this document

This is two things in one file:

1. A **step-by-step reproduction guide** (Sections 1-4) - detailed enough
   that someone who has never touched this project can stand up an
   identical deployment from a clean AWS account.
2. A **retrospective + reusable AI prompt** (Sections 5-7) - so the lessons
   from this cycle aren't lost, and next year's team (human or AI-assisted)
   starts from where this one left off, not from zero.

If you're an AI agent picking this up in 2027: read Section 7 first, then
come back to Section 1.

---

## 1. Architecture Setup (Solutions Architect)

### 1.1 What you're building

A fully serverless, UK-only web application that helps students find UCAS
Clearing courses, plus an optional analytics/monitoring layer. Two
independently-deployable scopes:

- **Core**: public site + API. Search, subjects, universities,
  scholarships, export, health check. Geo-restricted to the UK via
  CloudFront + AWS WAF.
- **Full** (core + `--full`): adds CloudWatch alarms/dashboards + email
  alerts, Results-Day auto-scaling, and a Grafana analytics dashboard on
  EC2.

### 1.2 Region strategy

- Application + data: **eu-west-2** (London) - a UK-only product belongs in
  a UK region.
- WAF for CloudFront, and the Grafana front-door WAF + CloudFront: **must**
  be **us-east-1**. This is an AWS platform requirement (CloudFront WAF
  WebACLs are global-scoped and only creatable in `us-east-1`), not a
  configuration choice - do not try to change this.

### 1.3 Stack inventory (deploy in this order - dependencies flow downward)

| Order | Stack | Region | Owns |
|---|---|---|---|
| 1 | `uk-clearing-advisor-data` | eu-west-2 | DynamoDB reference + operational tables |
| 2 | `uk-clearing-advisor-compute` | eu-west-2 | Lambda functions, IAM roles, log groups, the `SearchCourses` alias |
| 3 | `uk-clearing-advisor-api` | eu-west-2 | HTTP API, routes, throttle, access logs |
| 4 | `uk-clearing-advisor-waf` | us-east-1 | App WAF WebACL (geo, rate limit, managed rules) |
| 5 | `uk-clearing-advisor-cdn` | eu-west-2 | CloudFront, S3 site + exports buckets, OAC |
| 6 (full only) | `uk-clearing-advisor-observability` | eu-west-2 | SNS, alarms, log metric filters, dashboards |
| 7 (full only) | `uk-clearing-advisor-scaling` | eu-west-2 | Results-Day provisioned-concurrency scale up/down |
| 8 (full only) | `uk-clearing-advisor-grafana` | eu-west-2 | Grafana EC2, EIP, SG, Cognito, instance role |
| 9 (full only) | `uk-clearing-advisor-grafana-front` | us-east-1 | Grafana WAF + CloudFront |
| 10 (optional) | `uk-clearing-advisor-patching` | eu-west-2 | SSM Patch Baseline for the Grafana EC2 instance |

`deploy.sh` encodes this exact order and handles the chicken-and-egg
problems (e.g. the API's CORS origin isn't known until CloudFront exists,
so the API stack deploys twice: once with a placeholder, once tightened
after CDN is up).

### 1.4 Full reproduction procedure

**Prerequisites** - verify all of these before starting:

| Requirement | Check |
|---|---|
| AWS account (your own - nothing here is multi-tenant) | - |
| AWS CLI v2, authenticated | `aws --version` (need 2.x), `aws sts get-caller-identity` |
| Python 3.8+ | `python3 --version` |
| Bash (native on macOS/Linux; use WSL or Git Bash on Windows) | - |
| IAM identity with broad create permissions for first deploy (Lambda, DynamoDB, API Gateway, CloudFront, WAF, IAM, S3, EventBridge, CloudWatch, SNS) | Admin-equivalent for the first run; tighten afterward |

No Node.js/npm is required (Lambdas use only the AWS SDK v3 bundled into the
Node.js 22 runtime, packaged by a Python script). No Graphviz is required
unless re-rendering the architecture diagram.

**Step 1 - clone and authenticate:**

```bash
git clone https://github.com/usmanmehr/uk-clearing-advisor.git
cd uk-clearing-advisor
aws sts get-caller-identity   # must succeed before proceeding
```

**Step 2 - core deploy:**

```bash
./deploy.sh
```

This single command, in order:
1. Creates an artifacts S3 bucket, builds and uploads Lambda zips.
2. Deploys `data` (DynamoDB tables) and seeds universities + subject
   averages.
3. Deploys `compute` (Lambdas + IAM roles), generating a random shared
   origin secret on first run and reusing it on every subsequent run.
4. Deploys `api` (HTTP API + routes) with a placeholder CORS origin.
5. Deploys `waf` in us-east-1 (CloudFront WebACL).
6. Deploys `cdn` (CloudFront + S3 site/exports buckets), syncs the
   frontend, invalidates the cache, then re-deploys `api` with the real
   CloudFront domain as the tightened CORS origin.

Expect 10-15 minutes on a first run - CloudFront distribution propagation
is the slow part (typically 5-10 minutes).

At the end, the script prints the live site URL and API endpoint.

**Step 3 - full deploy (optional, adds monitoring/scaling/Grafana):**

```bash
export ADMIN_EMAIL=<your-alert-email>
export GRAFANA_VPC_ID=<vpc-id>
export GRAFANA_SUBNET_ID=<public-subnet-id-in-that-vpc>
export GRAFANA_ALLOWED_CIDR=<your-ip>/32
./deploy.sh --full
```

| Variable | Purpose | How to find it |
|---|---|---|
| `ADMIN_EMAIL` | Destination for CloudWatch alarm emails | Any inbox you can check |
| `GRAFANA_VPC_ID` | VPC for the Grafana EC2 instance | `aws ec2 describe-vpcs --query "Vpcs[].VpcId"` |
| `GRAFANA_SUBNET_ID` | A **public** subnet (needs an Elastic IP) | `aws ec2 describe-subnets --filters Name=vpc-id,Values=<vpc-id> --query "Subnets[].SubnetId"` |
| `GRAFANA_ALLOWED_CIDR` | Your IP, for direct admin access to Grafana as a fallback | `curl -s ifconfig.me` then append `/32` |

Running `./deploy.sh --full` directly (without a prior core-only run) works
too - it performs all core steps first, then the full-deploy steps.

After a full deploy:
- Confirm the SNS email subscription (check the inbox used for
  `ADMIN_EMAIL`).
- Create a Grafana login (no self-signup):
  ```bash
  aws cognito-idp admin-create-user \
    --user-pool-id <UserPoolId from the grafana stack output> \
    --username <email>
  ```
- The Grafana **admin** fallback password lives in Secrets Manager under
  `ClearingAdvisor-GrafanaAdmin`.

**Step 4 - optional daily OS patching for the Grafana instance:**

```bash
aws cloudformation deploy \
  --template-file stacks/patching.yaml \
  --stack-name uk-clearing-advisor-patching \
  --region eu-west-2 \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides GrafanaInstanceId=<grafana-instance-id>

aws ec2 create-tags \
  --resources <grafana-instance-id> \
  --tags "Key=Patch Group,Value=clearing-advisor-grafana" \
  --region eu-west-2
```

The tag step is required manually - CloudFormation cannot tag an instance
defined in a different stack.

---

## 2. Security Configuration (Security Engineer)

Reproduce these controls exactly - they are the actual security posture of
the current deployment, not aspirational:

1. **Geo-restriction, layered twice**: CloudFront geo-restriction (GB only)
   on the app distribution, plus a WAF rule (`stacks/waf.yaml`) doing the
   same at the edge. Grafana's WAF (`stacks/grafana-front.yaml`) instead
   allows GB **or** a named admin IP CIDR - broader access is intentional
   there for admin fallback.
2. **Origin-verify secret**: every API-facing Lambda checks a shared
   `X-Origin-Verify` header (`checkOriginSecret()` in
   `lambda/shared/shared.mjs`) and returns 403 if it's missing. This closes
   off direct `execute-api` access that would otherwise bypass WAF and the
   CloudFront geo-block entirely. `GET /health` deliberately skips this
   check so external uptime monitors can reach it directly - a scoped,
   documented exception.
3. **Secret generation, not defaults**: `deploy.sh` generates a random
   32-byte hex secret on first run and reuses it on every re-run by reading
   it back from a live Lambda's configuration. Never deploy
   `stacks/compute.yaml`, `stacks/cdn.yaml`, or `stacks/grafana.yaml` with a
   manually-typed placeholder value for `ApiOriginSecret`/`OriginSecret` -
   the parameter is `MinLength: 20` and required, by design, to make a
   forgotten override fail loudly rather than silently accepting a weak
   value.
4. **Least-privilege IAM**: every Lambda's execution role
   (`stacks/compute.yaml`) is scoped to exact table ARNs and only the
   actions that function actually needs. Do not consolidate roles or grant
   blanket DynamoDB access when adding new functions - follow the existing
   per-function pattern.
5. **CORS**: `stacks/api.yaml`'s `AllowOrigin` must be the real CloudFront
   domain, never `*` - the API is also reachable directly via its
   `execute-api` URL, so a permissive CORS value would let any website call
   it cross-origin.
6. **WAF managed rule posture**: `CommonRuleSet` runs in `Count` mode
   (observability only, to avoid false positives); `KnownBadInputs` and
   `SQLiRuleSet` run in blocking mode. This is a deliberate, documented
   choice - reproduce it as-is, but see Section 6 for why it should be
   revisited.
7. **Grafana origin hop is plaintext HTTP** between CloudFront and the EC2
   instance (`OriginProtocolPolicy: http-only` in
   `stacks/grafana-front.yaml`), compensated by the origin-verify secret and
   a security group that only accepts port 80 from CloudFront's own IP
   range. This is a known, tracked risk - see Section 6, item H2 - not a
   silent gap. Do not "fix" it ad hoc without reading that section first;
   there's a specific recommended remediation path already scoped.
8. **No request-level authentication on any API route** - by design, this
   is a public, accountless student tool. Do not add authentication in
   2027 without an explicit product decision to do so; the current
   security model relies entirely on the network-layer controls above.

---

## 3. Developer Environment Needs (Lead Developer)

- **No Node.js/npm required for deployment.** Lambda functions use only the
  AWS SDK v3 bundled in the Lambda Node.js 22 runtime; `scripts/build_lambdas.py`
  packages them with plain `zip`, not a JS build tool.
- **Editing Lambda code**: any change to `lambda/*/index.mjs` or
  `lambda/shared/*.mjs` requires re-running `deploy.sh` (it rebuilds and
  re-uploads zips as Step 1, and `aws cloudformation deploy` picks up the
  new S3 object). For `SearchCourses` specifically: a new Lambda **version**
  must be published and the `live` **alias** repointed to it -
  editing `$LATEST` alone never reaches production, because the API invokes
  the function via its alias so that provisioned concurrency (Results Day)
  actually applies.
- **Editing the frontend only** (`frontend/*`): skip the full `deploy.sh`
  run, just:
  ```bash
  aws s3 sync frontend/ s3://uk-clearing-advisor-site-<account-id>/ --delete
  aws cloudfront create-invalidation --distribution-id <dist-id> --paths "/*"
  ```
- **Editing CloudFormation templates** (`stacks/*.yaml`): run
  `cfn-lint` locally before pushing (CI runs it too, and blocks on errors):
  ```bash
  cfn-lint stacks/*.yaml
  ```
- **Editing grading/shared logic** (`lambda/shared/grading.mjs`,
  `lambda/shared/shared.mjs`): run the existing test file before deploying:
  ```bash
  node --test lambda/shared/shared.test.mjs
  ```
- **Committing changes**: this repo enforces a secrets/personal-data
  guardrail (`scripts/check_sensitive_content.py`, also run in CI as
  `sensitive-content-check`). Run it locally before committing anything
  that might contain real account IDs, emails, or credentials:
  ```bash
  python3 scripts/check_sensitive_content.py <changed files>
  ```
- **Local account-specific values**: `clearing.env` and `DEPLOYMENT.md` are
  both git-ignored deliberately - they hold real account IDs, domain names,
  and ARNs. Never remove them from `.gitignore`, and never hand-copy their
  contents into a tracked file.
- **Branch/PR convention observed this project**: one feature branch per
  logical change, pushed with `-u`, opened as a PR against `main`, merged
  only after `cfn-lint`, `lambda-tests`, and `sensitive-content-check` all
  pass.

---

## 4. End-User Verification (End User)

After any deploy (core or full), verify the experience a real UK student
would have - not just that stacks reached `*_COMPLETE`:

1. **From a UK IP** (or UK VPN/proxy - this is geo-restricted by design,
   testing from outside the UK will correctly show a 403/geo-blocked page):
   - Load the site's CloudFront URL. It should render the search form.
   - Run a real search (a common subject + typical grades) and confirm
     results return with the "estimated data" disclosure visible - this
     project has no live UCAS feed, so results are seeded/estimated, not a
     guaranteed live availability check.
   - Confirm the "Good to know" card distinguishes exact grade-conversion
     arithmetic from estimated course availability.
   - Try `/export` on a completed search and confirm a working presigned
     download link (XLSX and PDF).
   - Load `/health` directly and confirm a 200 with `"status":"ok"`.
2. **From outside the UK**: confirm you see the geo-blocked page, not the
   site. If you see the real site from a non-UK IP, that's a regression in
   the geo-restriction, not a success.
3. **If full deploy was run**:
   - Confirm the alert email subscription is actually confirmed (check
     `aws sns get-subscription-attributes`, not just that a confirmation
     email was sent).
   - Log into Grafana via the created Cognito user and confirm the
     dashboard panels populate with real data.
4. **Do not consider the deploy verified from CLI output alone.** Every
   verification in this project's own history that mattered was confirmed
   with a real request (a real search, a real curl against a live
   endpoint, a real Logs Insights query) - CLI commands returning
   without error are necessary but not sufficient.

---

## 5. Lessons Learned

These are drawn from this cycle's actual review findings
(`WELL-ARCHITECTED.md`) and operational history (`CHANGELOG.md`), not
generic best practice:

- **Documentation drift is a real, recurring failure mode in this project,
  not a hypothetical one.** `DEPLOYMENT.md` (git-ignored, so untracked by
  CI or PR review) fell out of sync with actual deployed state more than
  once. `ARCHITECTURE.md`'s stack-inventory table also drifted (alarm/filter
  counts) until manually caught and corrected mid-cycle. Any doc that
  states specific counts, resource names, or "what's deployed" needs either
  automated verification against live state, or an explicit habit of
  re-checking it at the end of every deploy session - not just when
  something feels off.
- **A documented feature flag that was never built** (`UCAS_ENABLED`,
  referenced in both `shared.mjs` and `ARCHITECTURE.md`, but with zero
  actual code behind it) cost real investigation time to discover. Lesson:
  when a comment says "behind a feature flag," verify the flag exists in
  code before trusting the comment, and never write a "TODO: gate this
  behind X" comment without actually building X or removing the comment.
- **Two config-propagation traps were each hit more than once before being
  written down**: (1) `SearchCourses` must be invoked via its `live` alias
  - a new published version + a repointed alias is required for any code
  change to reach production, editing `$LATEST` alone silently does
  nothing; (2) the Grafana EC2 instance's UserData only runs once at first
  boot, so any domain or config change to an already-running instance needs
  manual SSM re-provisioning, not just a CloudFormation redeploy. Both are
  now documented in `ARCHITECTURE.md`'s operational-traps note - keep that
  note current as new traps are discovered.
- **CloudFormation-level errors are sometimes only discoverable at deploy
  time, not from documentation.** For example, `AWS::Logs::MetricFilter`
  rejects a `MetricTransformation` that sets both `Dimensions` and
  `DefaultValue` together - this constraint was not obvious from the
  official property reference page and only surfaced as a `CREATE_FAILED`
  on a real deploy attempt. Lesson: always validate and deploy to a real
  account before considering a template change complete, even when the
  documentation reads as unambiguous.
- **CLI tooling flakiness during a long session is real and should be
  planned for**, not fought. Blank or truncated stdout, or transient
  "path does not exist" errors on files that do in fact exist a moment
  later, occurred repeatedly. The reliable workaround: redirect output to a
  file and read it back independently, and re-verify with a second call
  before concluding a command failed.

## 6. Areas for Improvement

Carried forward directly from `WELL-ARCHITECTED.md`'s prioritised
recommendations, still open as of this cycle:

1. **Reliability - no DLQ or Lambda Destinations on async-invoked
   functions** (`DailyScraper`, `CostReporter`). A failed EventBridge-
   triggered run is retried twice by the Lambda service, then dropped with
   no record beyond CloudWatch Logs for that one invocation. Add an
   `OnFailure` Destination or a DLQ before the 2027 cycle.
2. **Reliability - inconsistent DynamoDB retention.** Only 4 of 8 tables
   have `DeletionPolicy: Retain`. `ChangeLogTable` (an audit trail, not a
   cache) should get one at minimum. `RateLimitsTable` is also the only
   table without `PointInTimeRecoverySpecification`.
3. **Security - H2, plaintext HTTP between CloudFront and the Grafana
   origin.** Deliberately deferred to before the 2027 Results Day cycle -
   do not let it slip further. The scoped fix already identified: a Let's
   Encrypt certificate via DNS-01 against the real domain already in
   Route 53, then flip `OriginProtocolPolicy` to `https-only`. CloudFront
   VPC Origins was considered and rejected as disproportionate (needs a
   private subnet + NAT/VPC endpoints) for infrastructure that only runs a
   few weeks a year.
4. **Operational Excellence - `CommonRuleSet` has been in WAF `Count` mode
   without a revisit date.** Review its Count-mode CloudWatch metrics and
   either move it to `Block` or set an explicit revisit date - "avoid false
   positives" without a revisit plan tends to become permanent by default.
5. **Cost - no AWS Budgets alarm exists.** `CostReporter` publishes a
   visibility metric, but nothing pages if spend crosses an unexpected
   threshold. Add an `AWS::Budgets::Budget` wired into the existing SNS
   alerts topic.
6. **Test coverage is effectively zero outside grading arithmetic.** No
   tests exist for `checkOriginSecret()`, the rate-limiting logic, any
   Lambda handler end-to-end, the frontend, or either Python script. Start
   with `checkOriginSecret()` and rate-limiting specifically - every
   API-facing Lambda's main security control depends on both, and neither
   has a single test.
7. **Sustainability/Cost - no Graviton adoption.** Lambda functions default
   to x86_64; the Grafana EC2 instance is `t3.small` rather than `t4g.small`.
   Both are low-effort (no native dependencies anywhere in the codebase)
   with combined cost and sustainability upside.
8. **Version/alias naming drift in `compute.yaml`.** A Lambda `Version`
   logical resource's name and its `S3Key` reference can silently drift out
   of sync (observed this cycle) - the outcome is still correct on the next
   deploy, but the template misleads a reader about which version is
   actually live. Consider a naming convention that can't drift (e.g.
   deriving the logical ID from a hash of the zip, not a manually
   incremented number).
9. **Load testing has never been done.** `SearchCourses` runs at 512 MB
   with no evidence it's been right-sized against real Results-Day-scale
   concurrency. The scaling stack controls *how many* parallel executions
   run, not whether 512 MB is the correct size for each one.

---

## 7. Future Prompting - Master Prompt for the 2027 AI-Assisted Deployment

Copy the block below verbatim as the opening instruction to an AI agent
starting the 2027 rollout. It is self-contained - the agent should not need
this entire surrounding document, only the block, plus read access to the
repository.

```
You are assisting with the 2027 Results Day rollout of UK Clearing Advisor,
a serverless, UK-only AWS application that helps students find UCAS
Clearing courses. This is a yearly-recurring deployment with prior
history - do not treat this as a greenfield project.

Before making any change:
1. Read DEPLOY.md and deploy.sh in full - they are the authoritative,
   tested deployment procedure. Do not invent alternative deployment steps.
2. Read ARCHITECTURE.md for the current stack inventory and the
   "I want to change X -> edit here" table.
3. Read WELL-ARCHITECTED.md's "Prioritised recommendations" section and
   this document's Section 6 ("Areas for Improvement") - treat any item
   still unresolved there as known technical debt, not a new discovery.
   Check off items that were actually fixed since, and add newly-found
   ones using the same format (file-cited, graded Good/Risk/Gap).
4. Read the most recent CHANGELOG.md entries to understand what changed
   since this document was written, and update this document's Sections
   1-4 if the deployment procedure itself has changed.

Operating rules for this engagement:
- This is a production system serving real students during a high-traffic
  window (Results Day). Treat all AWS credentials as production-scoped
  unless explicitly told otherwise, and confirm before any destructive
  action (stack deletion, table deletion, secret rotation without a
  rollback plan).
- Prefer infrastructure-as-code (the existing CloudFormation templates in
  stacks/*.yaml) over direct CLI changes for anything meant to persist.
- Verify every claim about live behaviour with a real check against the
  actual AWS account (a real CLI query, a real HTTP request from a UK
  vantage point) - do not report a deploy as verified from template review
  or CLI exit codes alone.
- Follow this repo's existing git convention: feature branch, PR against
  main, wait for cfn-lint + lambda-tests + sensitive-content-check to pass,
  merge only when asked.
- Run scripts/check_sensitive_content.py before committing anything that
  might contain real account IDs, domain names, or credentials. Never
  commit DEPLOYMENT.md or clearing.env (both git-ignored on purpose).
- If you find yourself repeating a fix for the same root cause more than
  once, stop and check WELL-ARCHITECTED.md and this document's Section 6 -
  it may already be a tracked, known issue with a scoped recommendation
  rather than something to patch ad hoc.
- At the end of this rollout, update this document: move resolved items
  from Section 6 into a dated "Resolved" note, add newly-discovered issues
  in the same format, and add a new Section 8 with this cycle's own
  lessons learned, following the structure already established in
  Sections 5-6.

Your first task is: [insert the specific 2027 task here, e.g. "run the
core deploy into a fresh AWS account and verify end-to-end" or "review
WELL-ARCHITECTED.md item H2 and implement the scoped Let's Encrypt fix"].
```

---

## 8. Document History

| Date | Change |
|---|---|
| (fill in at 2027 rollout) | Initial version, produced from the 2026 deployment cycle. Reproduction steps grounded in `DEPLOY.md`/`deploy.sh` as they existed at the time; retrospective grounded in `WELL-ARCHITECTED.md`'s 28 Jul 2026 review and `CHANGELOG.md`. |

---

## Appendix: saving this document

If you need to (re)create this file on a standard dev machine from inside
the project directory:

```bash
mkdir -p document
# Paste or write the full content of this guide into the file below,
# e.g. using your editor of choice, or a heredoc if scripting it:
cat > document/2027-REPRODUCTION-GUIDE.md << 'EOF'
<paste the full contents of this document here>
EOF
```

If you're committing it to git (recommended, so it version-controls
alongside the infrastructure it describes):

```bash
python3 scripts/check_sensitive_content.py document/2027-REPRODUCTION-GUIDE.md
git add document/2027-REPRODUCTION-GUIDE.md
git commit -m "Add 2027 reproduction and retrospective guide"
```
