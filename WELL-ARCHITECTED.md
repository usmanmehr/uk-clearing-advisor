# UK Clearing Advisor - AWS Well-Architected Review

Review date: 28 July 2026. Scope: all 10 CloudFormation stacks
(`stacks/*.yaml`), all Lambda handlers (`lambda/*/index.mjs`,
`lambda/shared/*.mjs`), the frontend (`frontend/*`), CI (`.github/workflows/`),
and the project's own docs (`README.md`, `ARCHITECTURE.md`, `DEPLOYMENT.md`,
`CHANGELOG.md`).

This is a point-in-time assessment against the six AWS Well-Architected
Framework pillars: Operational Excellence, Security, Reliability, Performance
Efficiency, Cost Optimization, and Sustainability. Every finding below cites
the exact file (and, where useful, the resource or line context) it's based
on, so it can be re-verified independently rather than taken on trust.

Findings are graded:
- **Good** - a deliberate, correct decision worth keeping as-is.
- **Risk** - works today but has a real, identifiable failure mode.
- **Gap** - missing entirely; no mitigation exists.

## How to read this document

This is not a certification. AWS's own Well-Architected Review is a
structured workshop against ~50-60 numbered questions per pillar; this
document instead audits the actual deployed configuration and code against
the same six pillars' intent, using this project's own file-cited standard of
evidence (the same standard `CHANGELOG.md` entries use). Treat it as an
engineering review, not a pass/fail badge.

---

## 1. Operational Excellence

**Good**
- CI (`.github/workflows/cfn-lint.yml`) runs `cfn-lint` on every template
  push (errors block, warnings don't) and `node --test lambda/shared/*.test.mjs`
  - both real, automated gates rather than a lint badge with nothing behind it.
- `CHANGELOG.md` discipline is genuinely good: every change since 22 Jul 2026
  documents what was done, what was verified, and what was deliberately
  rejected and why (e.g. auto-adjusting scraper frequency, rejected for
  oscillating-feedback-loop risk - `stacks/observability.yaml`
  `ScraperDriftAlarm` comment).
- `deploy.sh` + `DEPLOY.md` replaced a previously undocumented ~10-command
  manual sequence, and the shared origin secret is generated once and reused
  on re-runs rather than rotated unpredictably.
- `ARCHITECTURE.md`'s "where to change what" table is a real, maintained
  operational runbook, not boilerplate - it correctly documents the two known
  operational traps in this system: (1) `SearchCourses` must be invoked via
  its `live` alias, so a code change needs a new published version + a
  repointed alias, editing `$LATEST` alone never reaches production; (2)
  Grafana EC2 UserData only runs once at boot, so any domain/config change to
  a running instance needs manual SSM re-provisioning, not just a stack
  redeploy - learned the hard way twice this session (custom domain,
  dashboard.json updates) and now written down.

**Risk**
- **`stacks/compute.yaml`'s `SearchCoursesVersionV6` / `S3Key:
  lambda/SearchCourses-v18.zip` naming has drifted from itself.** The
  template's own comment says the `Version` resource is "kept in sync with
  the live alias" to avoid `cloudformation deploy` reverting hotfixed code,
  but the `Version` logical ID says `V6` while the `S3Key` says `v18` - twelve
  versions out of sync in the label alone. This is exactly the kind of drift
  the comment is trying to prevent, just not eliminated by it. A future
  deploy will still create a new Version pointing at `v18`'s content (correct
  outcome) but anyone reading the template gets a wrong signal about which
  version is actually live.
- `DailyScraperFunction`, `WarmUpFunction`, `HealthFunction`, and
  `CostReporterFunction` have no published version/alias at all (unlike
  `SearchCourses`) - fine today since none of them need provisioned
  concurrency, but it means every one of them updates `$LATEST` directly on
  deploy with zero rollback mechanism if a bad deploy breaks the daily
  scraper or cost reporting silently.

**Gap**
- **`DEPLOYMENT.md` is stale relative to `CHANGELOG.md`.** It's dated
  "Deployed: 22 July 2026" and its "Not yet deployed" section still lists
  "Custom domain / ACM / Route 53" as undone. Per `CHANGELOG.md`'s
  2026-07-29 and 2026-07-29 (2) entries, the custom domain for both the main
  CloudFront distribution and the Grafana front door were deployed live over
  a week ago. `DEPLOYMENT.md` is git-ignored (per `.gitignore`) so this can't
  be caught by CI or a PR diff - it will keep silently drifting unless
  someone remembers to hand-edit it after every deploy. This is a real
  handover risk: a teammate reading `DEPLOYMENT.md` cold would believe the
  site is still on the default CloudFront domain.
- **A documented feature flag that doesn't exist in code.**
  `lambda/shared/shared.mjs` line 7 states: "Live UCAS enrichment is
  implemented behind a feature flag (`UCAS_ENABLED`) for when a key is
  added." Grepping the entire `lambda/` tree for `UCAS_ENABLED` finds this
  one comment and nothing else - no env var read, no conditional, no dead
  code path. `ARCHITECTURE.md` line 195 repeats the same claim ("enable the
  fetch behind the existing feature flag"). Whoever eventually wires the
  UCAS API will discover there's nothing to flip - the flag needs to be
  built, not enabled. This is a small thing but it's exactly the kind of
  doc-vs-code mismatch that costs real time during an incident or a handover.
- **Zero test coverage for anything except pure grading arithmetic.** The
  entire repository has exactly one test file,
  `lambda/shared/shared.test.mjs`, and it tests only
  `lambda/shared/grading.mjs` (A-level/BTEC Tariff-point conversion - now
  verified exhaustively per the 2026-07-30 (2) CHANGELOG entry). There are
  no tests for: `checkOriginSecret()` or the rate-limiting logic in
  `shared.mjs`; any of the 10 Lambda handlers end to end; the frontend
  (`app.js` form validation, share-URL encoding/decoding); or either Python
  script (`scripts/seed.py`, `scripts/build_lambdas.py`). The CI job name
  itself, `lambda-tests`, implies broader coverage than exists.
- No runbook exists for the two open, unfixed operational issues currently
  tracked only in `CHANGELOG.md` prose: the recurring `DailyScraper`
  `undici AssertionError` (Cambridge/Coventry, ~2 errors/run since 22 Jul,
  "not yet fixed - flagged for follow-up") and the unrevisited alarm
  thresholds (`ScraperDriftAlarm` at 15 changes/6h, explicitly flagged in its
  own template comment as needing revisiting before 13 Aug). Both are
  correctly logged, but there's no tracked action item format (issue, TODO
  file) - they exist only as narrative text in a changelog someone has to
  remember to reread.

---

## 2. Security

This is the strongest pillar in the system, but it has one real, unmitigated
exposure worth fixing before Results Day traffic.

**Good**
- IAM roles in `stacks/compute.yaml` are per-function and scoped to exact
  table ARNs (e.g. `SearchCoursesRole` only gets `Scan`/`GetItem`/`Query` on
  the three reference tables it reads and `GetItem`/`PutItem`/`UpdateItem`/
  `Query` on the three it writes - no function has blanket DynamoDB access).
  The few `Resource: '*'` exceptions are each individually justified and
  documented in-template: `CostReporterRole`'s `ce:GetCostAndUsage` (Cost
  Explorer has no resource-level ARNs - compute.yaml lines ~253-257),
  `RampUpScraperSchedulerRole`'s confused-deputy-hardened trust policy
  (`aws:SourceAccount` + `aws:SourceArn` scoped to the schedule group), and
  `ScheduleManagerRole`'s `logs:*Delivery*` actions in `stacks/scaling.yaml`
  (required for API Gateway `UpdateStage`, which has no narrower ARN either).
- CloudFront-to-API-Gateway bypass was found and fixed (`CHANGELOG.md`
  2026-07-23): every API-facing Lambda now checks a shared `X-Origin-Verify`
  header via `checkOriginSecret()` (`lambda/shared/shared.mjs`) and returns
  403 if it's missing - closing off direct `execute-api` access that
  previously skipped WAF and the CloudFront geo-block entirely.
- CORS `AllowOrigin` was tightened from `["*"]` to the live CloudFront domain
  (`stacks/api.yaml`, fixed per the 2026-07-23 "Well-Architected review
  follow-up" changelog entry) - a real production misconfiguration that was
  caught and closed.
- `GET /health` deliberately skips the origin-secret check (documented in
  `HealthFunction`/`shared.mjs`) so external uptime monitors can reach it
  directly - a scoped, intentional exception rather than an oversight.
- Most of Grafana's attack surface is well thought through even though the
  CloudFront-to-origin hop itself is not (see H2 below): Cognito OAuth for
  login, an IAM instance role instead of static keys, and a security group
  that opens port 80 only to the CloudFront origin-facing prefix list and
  port 443 only to a single named admin IP (`stacks/grafana-front.yaml`).
  `server_tokens off` was added after a pen test found nginx was disclosing
  its exact version (`CHANGELOG.md` 2026-07-23 pen test entry).
- A real, active AWS access key was found in plaintext on the developer
  workstation (`~/.aws/credentials`, `.bash_history`) during the pen test.
  It was confirmed absent from the git repository and its history, correctly
  scoped as a workstation risk rather than an application vulnerability, and
  documented rather than silently ignored.

**Risk**
- **H2 - CloudFront-to-Grafana origin is plaintext HTTP over the public
  internet; admin cookies and the origin secret travel unencrypted**
  (`stacks/grafana-front.yaml`, `OriginProtocolPolicy: http-only`). The root
  cause: CloudFront will only trust an HTTPS custom origin if its
  certificate is issued by a CA on Mozilla's included list, and the
  Grafana EC2 instance's only reachable hostname is a `nip.io` wrapper
  around its Elastic IP (`stacks/grafana.yaml`), so nginx's cert there is
  self-signed and CloudFront would reject it over HTTPS. HTTP +
  `X-Origin-Verify` secret header + a security-group lock to CloudFront's
  own IP range is the current compensating control, not the fix.
  Considered and evaluated two real fixes - AWS CloudFront VPC Origins
  (GA Nov 2024, confirmed available in this account/region via
  `aws cloudfront list-vpc-origins`), and a Let's Encrypt cert issued via
  DNS-01 against the real `monitor.mehrs.net` domain already in Route 53 -
  and rejected doing either right now. VPC Origins needs the instance
  moved to a private subnet plus a NAT Gateway or VPC endpoints for
  outbound package/Cognito calls - a genuine architecture change and
  ongoing cost for infrastructure that exists for a few weeks a year.
  Let's Encrypt is a smaller, scoped fix (swap the self-signed cert,
  flip `OriginProtocolPolicy` to `https-only`, add a renewal job) and is
  the one worth doing, but not mid-review with Results Day traffic on the
  horizon. **Deferred deliberately to before the 2027 Results Day cycle**,
  not dropped - tracked here rather than only in chat so it doesn't get
  forgotten. Current compensating controls (CloudFront-IP-only ingress via
  the security group, and the shared secret) remain in place in the
  meantime; rotating that secret periodically is the practical mitigation
  until the real fix lands.
- **`checkOriginSecret()` fails open, and the default value is a placeholder
  that looks like a real secret.** `lambda/shared/shared.mjs` line 89:
  `if (!API_ORIGIN_SECRET) return true;` - if the env var is empty, every
  request is treated as verified. The template default in
  `stacks/compute.yaml` was a short, static placeholder string, not a real
  secret. If a stack is ever deployed
  without explicitly overriding `ApiOriginSecret` (a plausible mistake in a
  staging environment, a forked deploy, or a parameter typo), the origin
  check silently becomes a no-op rather than failing loudly. `deploy.sh` does
  generate and reuse a real secret on every run per its own documentation,
  so production as deployed today is not exposed - but the template itself
  has no built-in guard (e.g. an `AllowedPattern` rejecting the literal
  default, or a `Rule` in the CFN template) against someone deploying it with
  the placeholder still in place.
- **`stacks/waf.yaml`'s `CommonRuleSet` is `OverrideAction: Count`, not
  `Block`** (lines 66-69), while `KnownBadInputs` and `SQLiRuleSet` are both
  `OverrideAction: None` (i.e. blocking, lines 80-98). This is a documented,
  deliberate choice ("avoid false positives" per the in-template comment and
  `DEPLOYMENT.md`), but it means AWS's broadest managed rule group -
  covering things like oversized bodies, generic bad-bot signatures, and
  cross-site scripting patterns not caught by the more targeted rule
  groups - is currently observability-only in production. Worth a scheduled
  review of what `CommonRuleSet` would actually have blocked, using its
  Count-mode CloudWatch metrics, rather than leaving it in Count
  indefinitely by default.
- Turnstile/CAPTCHA is fully absent from production (no key configured).
  Per `DEPLOYMENT.md`, this is treated as an "outage" and allowed through by
  design, leaving honeypot + WAF + DynamoDB rate limiting as the only active
  bot defences. That's a reasonable interim posture, but it's worth noting
  explicitly that one of the four originally-designed anti-bot layers is not
  actually running.

**Gap**
- No IAM authorizer, API key, or any request-level authentication exists on
  any of the 6 API Gateway routes (`stacks/api.yaml`) - by design, since this
  is a public student-facing tool with no accounts. This is an appropriate
  design for the product, not a flaw, but it's worth stating explicitly as a
  boundary of this review: every route is protected only by the layers
  above (WAF geo-block, origin secret, rate limiting), and there is no
  secondary authorization layer if any one of those is misconfigured or
  bypassed.

---

## 3. Reliability

This is the weakest pillar. Nothing here is actively broken, but several
real single points of failure exist with no fallback.

**Risk**
- **Only 4 of 8 DynamoDB tables have `DeletionPolicy: Retain`.**
  `stacks/data.yaml`: `UniversityContactsTable`, `ScholarshipsTable`,
  `SubjectDefaultsTable`, and `CUGRankingsTable` (the seeded reference-data
  tables) are protected. `ClearingCacheTable`, `ChangeLogTable`,
  `QueryCacheTable`, and `RateLimitsTable` have no `DeletionPolicy`
  (CloudFormation default: `Delete`). A stack deletion or a table replacement
  triggered by an incompatible property change would silently destroy the
  change log and rate-limit state with no way back. These four are lower-
  value data than the reference tables, but `ChangeLogTable` specifically is
  the audit trail for every detected clearing-page change - losing it loses
  history, not just cache.
- **`RateLimitsTable` has no `PointInTimeRecoverySpecification` at all**
  (`stacks/data.yaml`) - every other one of the 8 tables does. Low severity
  given what it stores, but it's an inconsistency with no documented reason.
- **No DLQ, no Lambda Destinations, and no reserved concurrency on any of
  the 10 Lambda functions** (`stacks/compute.yaml` - confirmed by grep, no
  `DeadLetterConfig`/`DestinationConfig`/`ReservedConcurrentExecutions`
  anywhere in the template). A failed async invocation (e.g. an EventBridge-
  triggered `DailyScraper` or `CostReporter` run that throws) is retried
  twice by the Lambda service and then dropped with no record anywhere
  except the CloudWatch Logs entry for that specific invocation. Both
  functions matter operationally: a silently-dropped `DailyScraper` run
  means a full day where status changes go undetected with no alert, and a
  silently-dropped `CostReporter` run means a gap in the cost dashboard with
  no signal that it happened.
- **`CostReporterFunction` and `ScheduleManagerFunction` handlers have no
  top-level try/catch** (confirmed by reading `lambda/CostReporter/index.mjs`
  and the `ScheduleManager` handler) - an unhandled exception propagates as
  a raw Lambda failure rather than a structured error the existing
  `logError`/metric-emission pattern used elsewhere in the codebase would
  catch. `DailyScraper`'s handler has the same gap around its top-level
  `ScanCommand` - only the per-university `processOne()` calls are
  individually try/caught, so a failure in the initial scan of
  `UniversityContactsTable` itself is unhandled.
- **S3 buckets have no versioning and no explicit `DeletionPolicy`**
  (`stacks/cdn.yaml` `StaticSiteBucket`, `ExportsBucket` - confirmed no
  `VersioningConfiguration` block in either, default `DeletionPolicy:
  Delete`). A bad `aws s3 sync --delete` to the site bucket, or an
  accidental stack deletion, has no recovery path other than re-syncing from
  git (fine for the static site, since it's all in version control) or
  losing generated exports outright (acceptable, since exports are
  regenerable and already have a 1-day lifecycle).
- Single-region by design: compute/data in `eu-west-2`, WAF/CloudFront
  control plane in `us-east-1` (inherent to CloudFront, not a choice). There
  is no multi-AZ or multi-region DR story anywhere in the templates or docs,
  and no RTO/RPO target is documented. For a UK-only, free, non-commercial
  student tool this is a defensible scope decision, but it should be a
  stated decision rather than an implicit gap - an `eu-west-2` regional
  outage on Results Day itself would take the whole site down with no
  documented recovery time expectation.

**Good**
- `possibleStatusChange` is a genuinely good reliability pattern for data
  staleness: it's set by the scraper but never cleared by it (only a human
  re-seed clears it), so a detected drift can't quietly disappear before
  anyone reviews it (`CHANGELOG.md` 2026-07-23).
- SSM Patch Manager (`stacks/patching.yaml`) keeps the one long-lived
  compute resource (the Grafana EC2 instance) patched daily with
  `ApproveAfterDays: 0` for Security/Bugfix classifications - a real
  operational safeguard for the only non-serverless piece of the stack.

---

## 4. Performance Efficiency

**Good**
- `SearchCoursesFunction` uses a published version + `live` alias
  specifically so provisioned concurrency can be attached only during the
  Results Day window (`stacks/scaling.yaml` `ScheduleManagerFunction`,
  scale-up/scale-down cron rules), then removed afterwards - avoiding
  standing provisioned-concurrency cost outside the one day it's needed.
- `TracingConfig: { Mode: Active }` (X-Ray) is enabled on `SearchCourses` and
  `GenerateExport` - the two functions where end-to-end latency actually
  matters to the user - but not on the lighter, less latency-sensitive
  functions like `GetSubjects`, which is a reasonable, deliberate scoping
  rather than blanket instrumentation.
- Response caching was deliberately removed everywhere (`CHANGELOG.md`,
  "Removed" section) because clearing status can change within the hour on
  Results Day - a considered trade-off of freshness over
  raw throughput, appropriate for this specific workload.
- `SearchDurationAlarm` (p99 `Duration` on `AWS/Lambda`) was added
  specifically to catch a real regression class (DynamoDB scan slowing as
  the dataset grows) before it surfaces only as a count of individual slow
  requests via `SlowSearchAlarm`.

**Risk**
- Log metric filters (`stacks/observability.yaml`) exist only on
  `SearchCourses`'s log group (`ErrorCountFilter`, `SlowSearchFilter`) - none
  of the other 9 functions have equivalent filters, so a performance
  regression in, say, `GenerateExport` (1024 MB, 30s timeout - the most
  resource-heavy function after `SearchCourses`) would not be visible on
  either dashboard unless it also happens to throw AWS/Lambda-level errors
  or throttles.
- `SearchCoursesFunction` runs at 512 MB. This is a reasonable default but
  there's no evidence in the repo of it having been load-tested or
  right-sized against real Results Day-scale concurrency (the scaling stack
  sizes *concurrency*, i.e. how many parallel 512 MB executions run, but
  nothing tests whether 512 MB is the right per-invocation size).

---

## 5. Cost Optimization

**Good**
- Tag-based cost visibility (`Application=uk-clearing-advisor` cascaded via
  stack-level `Tags` across all 9 original stacks) plus a dedicated
  `CostReporterFunction` publishing `ClearingAdvisor/DailyCostUSD` to
  CloudWatch/Grafana - correctly reasoned as necessary since the AWS account
  also runs unrelated workloads, so raw account billing would be
  meaningless (`CHANGELOG.md` 2026-07-24).
- WAF Bot Control (`stacks/waf.yaml` `EnableBotControl`, ~$10/month) is
  optional and off by default - a real paid feature correctly gated behind
  an explicit opt-in rather than always-on.
- Provisioned concurrency is scale-up/scale-down bounded to the Results Day
  window only (`stacks/scaling.yaml`), not a standing cost.
- This session separately found and remediated two pieces of real,
  previously-unflagged waste in the account: 20 orphaned EBS volumes
  (~$66/month) and CloudTrail logging the same management events three
  times over (~$8/month) - both fixed ahead of this review, evidence the
  cost-visibility work is translating into actual savings, not just
  dashboards.
- Grafana EC2 was right-sized from t3.medium to t3.small this session.

**Risk**
- `ce:GetCostAndUsage` has up to a 24h backfill lag for newly-activated cost
  allocation tags and CloudWatch can take up to 48h to make a
  more-than-24h-old-timestamped data point queryable (both documented and
  correctly worked around in `CHANGELOG.md` 2026-07-24) - not a flaw, but
  worth flagging that the cost dashboard has an inherent ~1-2 day lag baked
  in and should not be read as real-time.
- The hourly `RampUpScraperSchedule` (`stacks/compute.yaml`, active
  24 Jul-12 Aug) is a genuine, if small, sustained increase in Lambda
  invocations and outbound HTTP requests to 44 external university sites -
  already flagged in-template as "worth reconsidering if any university
  starts rate-limiting or blocking the scraper," which is also a cost
  question (more invocations = marginally more spend) as well as a
  reliability one.

**Gap**
- No AWS Budgets alarm exists anywhere in the templates - `CostReporter`
  publishes a metric for visibility, but nothing pages if daily spend
  crosses an unexpected threshold. For a project explicitly built to avoid
  surprise costs (per the EBS/CloudTrail waste already found and fixed this
  session), a `AWS::Budgets::Budget` with an SNS action into the existing
  `AlertsTopic` would close that loop rather than relying on someone
  checking the Grafana panel.

---

## 6. Sustainability

This pillar is barely addressed - not unusually so for a project this size,
but worth stating plainly rather than skipping.

**Good**
- The architecture is fully serverless for the application tier (Lambda +
  DynamoDB on-demand + S3 + CloudFront) - no idle compute, which is the
  single biggest sustainability lever available and it's already pulled by
  default, even if not framed that way in the docs.
- The one persistent compute resource (Grafana EC2) was right-sized down
  from t3.medium to t3.small this session, reducing its resource footprint.
- `PAY_PER_REQUEST` billing on every DynamoDB table means no over-provisioned
  idle capacity.

**Gap**
- No consideration of Graviton/Arm64 anywhere - Lambda functions don't set
  `Architectures: [arm64]` in `stacks/compute.yaml` (defaults to x86_64), and
  the Grafana EC2 instance type (`t3.small`) is x86 rather than the
  Graviton-equivalent `t4g.small`. Both are Well-Architected Sustainability
  and Cost Optimization recommendations simultaneously (Graviton is
  typically both cheaper and lower-carbon per unit of compute) and both are
  low-effort to adopt here: the Lambda code is plain Node.js with the AWS
  SDK v3 bundled in the runtime (no native binaries), and Grafana on AL2023
  supports `t4g` directly.
- No lifecycle/retention policy exists on `StaticSiteBucket` (the exports
  bucket has a 1-day lifecycle, but the site bucket doesn't need one - this
  is a non-issue, noted only for completeness).
- No consideration of the hourly scraper ramp-up's footprint beyond cost -
  44 outbound HTTP requests/hour to external institutions for ~3 weeks is a
  real, if small, amount of duplicated network traffic and downstream
  compute on servers this project doesn't control, which is exactly the kind
  of thing the Sustainability pillar asks you to weigh, not just the
  reliability/cost angle already covered above.

---

## Prioritised recommendations

0. ~~Fix browser/edge cache staleness on `app.js`/`styles.css`~~ - **Done**
   (2026-08-09): this review's Performance Efficiency section did not
   originally flag it, but a real incident on a related project (the 2027
   site) surfaced the same root cause here first - `frontend/index.html`
   referenced `/app.js`/`/styles.css` by a bare, unversioned path, and
   `deploy.sh` set no `Cache-Control` on upload, so CloudFront fell back to
   its own default TTL and a returning visitor's browser had no signal to
   ever re-fetch. Fixed with content-hashed filenames
   (`scripts/build_frontend.py`) + explicit per-file-type `Cache-Control`
   in `deploy.sh` (`no-cache` for HTML, `immutable`/1yr for the hashed
   assets). See CHANGELOG 2026-08-09 (2) for full verification.
1. ~~Fix `checkOriginSecret()`'s fail-open default~~ - **Done** (2026-07-30):
   removed the weak placeholder default from `ApiOriginSecret`/
   `OriginSecret` across `compute.yaml`, `cdn.yaml`, and `grafana.yaml` and
   made the parameter required with `MinLength: 20`, so a forgotten
   override now fails the deploy loudly instead of accepting a guessable
   value. Live app-pair secret (compute+cdn) rotated and verified in sync;
   the Grafana-pair secret was deliberately left alone due to unrelated
   stack drift (see the 2026-07-30 (5) changelog entry).
2. **Add `DeletionPolicy: Retain` to `ChangeLogTable`** at minimum (it's an
   audit trail, not a cache) and add `PointInTimeRecoverySpecification` to
   `RateLimitsTable` for consistency with the other 7 tables.
3. **Add a DLQ or Lambda Destination (OnFailure) to `DailyScraper` and
   `CostReporter`** - both are EventBridge-triggered async invocations with
   no failure record today beyond CloudWatch Logs for that one invocation.
4. **Update `DEPLOYMENT.md`'s "Not yet deployed" section** to reflect that
   custom domains are live, or better, since it's git-ignored and provably
   drifts, consider whether the account-specific parts (domain names, cert
   ARNs) can move to a small `.env`-style file referenced by, rather than
   duplicated inside, a doc that also needs to track deployment status.
5. **Either implement or remove the `UCAS_ENABLED` feature flag reference**
   in `shared.mjs` and `ARCHITECTURE.md` - a documented flag that doesn't
   exist will cost someone real debugging time.
6. **Move `CommonRuleSet` from `Count` to `Block`**, or document a concrete
   date/criteria for reviewing the Count-mode metrics and deciding - "avoid
   false positives" without a revisit plan tends to become permanent by
   default.
7. **Add an `AWS::Budgets::Budget`** wired into the existing `AlertsTopic`
   SNS topic, so unexpected spend pages the same way an operational alarm
   does, rather than only being visible on a dashboard someone has to check.
8. **Write tests for `checkOriginSecret()` and the rate-limiting logic** in
   `shared.mjs` next, before any handler tests - these are the two functions
   every single API-facing Lambda depends on for its main security control,
   and neither has a single test today.
9. **Consider Graviton (`arm64` Lambda architecture, `t4g` for Grafana EC2)**
   - a genuinely low-effort, low-risk change given the codebase has no
   native dependencies, with both cost and sustainability upside.
10. **H2 - encrypt the CloudFront-to-Grafana origin hop** - deliberately
   scheduled for before the 2027 Results Day cycle, not this year. Likely
   fix: a Let's Encrypt certificate via DNS-01 against `monitor.mehrs.net`
   (already a real Route 53 domain), then flip `stacks/grafana-front.yaml`'s
   `OriginProtocolPolicy` to `https-only`. CloudFront VPC Origins was
   considered and rejected as disproportionate for infrastructure that only
   runs a few weeks a year (needs a private subnet + NAT/VPC endpoints).
   Current compensating controls (CloudFront-IP-only security group, shared
   secret) stay in place until then - rotate the secret periodically as the
   interim mitigation.

## Overall verdict

This is not a blanket "Well-Architected" system, and it shouldn't be
described as one - but it's also not a system with careless gaps. Security
is the strongest pillar by a clear margin: least-privilege IAM is the norm
rather than the exception, a real pen test was run and its findings fixed,
and the one fail-open exposure that exists (`checkOriginSecret()`'s default)
is a template-default risk rather than a live production one, given how
`deploy.sh` actually generates the secret. Reliability is the weakest pillar:
no DLQs, inconsistent table retention, and an implicit (undocumented)
single-region posture are the kind of gaps that don't matter until the day
they do. Operational Excellence is mixed in an interesting way - the
changelog and architecture-doc discipline is better than most production
systems this size, but that same discipline makes the one place it's
slipped (`DEPLOYMENT.md`, the phantom feature flag) more visible, not less.
Cost Optimization has real, demonstrated wins this session (EBS, CloudTrail)
built on genuine tag-based visibility. Sustainability is the pillar that's
had the least deliberate attention, though the serverless-by-default
architecture already earns credit it hasn't explicitly claimed.

For a non-commercial, UK-only student tool with no dedicated ops team, this
is a solid foundation with a short, concrete list of fixes rather than a
redesign - which is itself a fair outcome for a Well-Architected review to
land on.
