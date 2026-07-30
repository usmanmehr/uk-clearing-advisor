# Changelog

All notable changes to UK Clearing Advisor are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## 2026-07-30 (2)

### Added - exhaustive verification of grade-conversion accuracy
- Followed up a request to make results "99.99% accurate" by separating
  what's actually achievable from what isn't. Grade-to-UCAS-points
  conversion (A-level/BTEC tariff arithmetic) is pure logic that CAN be
  verified to near-100% confidence - and now is. Whether a specific
  university/course is actually open in Clearing at specific grades right
  now is NOT achievable to that confidence with this system's current
  architecture (seeded reference data + a heuristic scraper, not a live
  UCAS Clearing feed) - no amount of code hardening changes that, and
  claiming otherwise in the UI would be a false promise to students. This
  entry covers the part that's real; the frontend copy change below covers
  making sure the site doesn't imply the other part is more certain than
  it is.
- Found and independently verified a THIRD source for the BTEC Tariff
  tables (previously two: Pearson official + ukcalculator.com). Oxford
  Brookes University's own official admissions pages
  (achieving-112-points / achieving-128-points) state "BTEC Extended
  Diploma - Grades DMM" and "...Grades DDM" respectively, confirming
  DMM=112 and DDM=128 exactly. Also investigated and deliberately did NOT
  incorporate a discrepancy: those same Brookes pages' MIXED A-level+BTEC
  example combinations don't arithmetically check out and aren't even
  self-consistent with each other, while every PURE A-level example on the
  same pages checks out exactly - strong evidence those specific bullets
  are simplified marketing copy, not precise Tariff arithmetic. Documented
  in-line in `grading.mjs` as a deliberate decision, not silently ignored.
- Added exhaustive tests to `shared.test.mjs` that PROVE correctness
  programmatically rather than spot-checking: every one of the 21 BTEC
  grade values across all three tables is verified against its component
  decomposition (e.g. DDM = D + D + M = 48+48+32 = 128), every table is
  checked for strictly-descending values with no duplicates/negatives, and
  every BTEC Extended Diploma grade is verified to produce an exact
  (zero-drift) `gradeTotal()` result when submitted alone.

### Changed - front-page accuracy messaging is now explicit about what's exact vs. estimated
- The "Good to know" card previously blended exact facts (grade
  conversion) and estimates (course availability) into one paragraph.
  Split into two clearly labelled parts: "Exact" (Tariff point
  conversion, official published tables) and "Estimated" (everything about
  course/university availability, which needs a live UCAS feed this
  project doesn't have yet).

### Added - qualification-path analytics in Grafana
- `SearchCourses` now logs a structured `subjectsByType` array (subject +
  grade + qualification type per entry, not just a joined string) and two
  new fields: `qualificationPath` (`alevel-only` / `btec-only` / `mixed`)
  and `btecTypesUsed`.
- Added a `QualificationPathSearched` CloudWatch metric, dimensioned by
  path - the three real applicant profiles are now something you can
  actually report on with real usage numbers, not guess at.
- `grafana/dashboard.json`: 5 new panels - qualification path pie chart,
  qualification path trend over time, most popular BTEC size, course
  interest by qualification path (cross-tab), and subjects/grades entered
  by qualification path.
- Deployed live: verified the new metric and log fields with a real
  mixed-qualification search against production, and re-provisioned the
  Grafana dashboard on the running instance (dashboard.json only loads at
  boot via UserData, same lesson learned with the custom-domain work
  earlier - re-uploaded to S3 then re-fetched + restarted Grafana via SSM,
  not just a template redeploy).

## 2026-07-30

### Added - BTEC qualification support alongside A-levels
- Students applying with BTEC National qualifications (alone, or mixed with
  A-levels) can now search on equal footing with A-level-only applicants,
  rather than being unable to submit a real, common Clearing profile at all.
- `lambda/shared/grading.mjs`: added `BTEC_EXTENDED_DIPLOMA_VALUES`,
  `BTEC_DIPLOMA_VALUES`, and `BTEC_EXTENDED_CERTIFICATE_VALUES` (combined-
  grade UCAS Tariff points), verified directly against Pearson's own
  official table (qualifications.pearson.com/btec-int-com, Level 3 BTEC
  Nationals RQF, 2017 admissions cycle onwards - still the current table
  for 2026 entry) and independently cross-checked against
  ukcalculator.com - both agree exactly on every value used.
- Added a `QUALIFICATION_TYPES` registry (`alevel`, `btecExtendedDiploma`,
  `btecDiploma`, `btecExtendedCertificate`) recording each qualification's
  real UCAS sizing in A-level-equivalent "slots" (an Extended Diploma is
  sized as 3 A-levels, a Diploma as 2, an Extended Certificate as 1 - per
  Pearson's own sizing).
- Rewrote `gradeTotal()` to a slot-based model: every qualification entry
  contributes its Tariff points divided evenly across its own slots, pooled
  together, then the best 3 slots are averaged and scaled to a 3-subject
  total (same normalisation the 2-A-level fix already used - see the
  2026-07-2x entries). This is mathematically exact for every real BTEC
  combined grade (each is a uniform sum of the same per-component values),
  not an approximation, and reproduces the original A-level-only behaviour
  unchanged when every entry is an A-level. Verified against UCAS's own
  published worked example ("1 A-Level A + BTEC Diploma DD = 144 points")
  and 11 other cases in `lambda/shared/shared.test.mjs`.
- Added `totalQualificationSlots()` and changed `SearchCourses`'s
  validation from "at least 2 array entries" to "at least 2 A-level-
  equivalent slots" - a single BTEC Diploma or Extended Diploma alone (2 or
  3 slots) is a completely normal applicant profile and was previously
  rejected outright by the old entry-count rule.
- `SearchCourses`: `subjectWarning` wording no longer says "A-level X" - a
  BTEC in a relevant subject can also satisfy a course's usual subject
  requirement at many universities. Added a `type` field to each submitted
  qualification entry (optional, defaults to `alevel` for full backward
  compatibility with existing requests/shared links) and a `BtecSearchCount`
  metric to track real-world adoption.
- Frontend: each qualification row now has a "Qualification" dropdown
  (A-level / BTEC Extended Diploma / BTEC Diploma / BTEC Extended
  Certificate) that swaps the grade dropdown to that qualification's real
  grade scale (e.g. A*-E for A-level vs D*D*D*-PPP for a BTEC Extended
  Diploma). The submit button and shareable-URL encoding both use the same
  slot-counting logic as the backend. Old shared links (2-part
  `subject:grade`, no type) still prefill correctly as A-levels.
- No `node`/npm runtime was available to run `node --test` directly in this
  session; the algorithm was verified with an equivalent standalone script
  reproducing the exact same logic (all cases matched expected UCAS points
  exactly, including the cross-check against UCAS's own published worked
  example) before being written as permanent tests. Real test execution
  happens via the existing CI workflow (GitHub Actions, Node 22).

## 2026-07-29 (2)

### Added - optional custom domain for the Grafana front door
- `stacks/grafana-front.yaml` gained the same optional `DomainName`/
  `CertificateArn` parameters added to `stacks/cdn.yaml` earlier - default
  blank, no impact on existing deployments. Sets `Aliases` + an ACM-backed
  `ViewerCertificate` (SNI, `TLSv1.2_2021` minimum) when `DomainName` is set.
- Unlike the main site's CloudFront distribution, this front door's
  `FrontDomain` value is also baked into the Grafana EC2 instance's boot
  UserData (nginx origin listener, `GF_SERVER_ROOT_URL`,
  `GF_SECURITY_CSRF_TRUSTED_ORIGINS`) and into the Cognito app client's
  `CallbackURLs`/`LogoutURLs`. Amazon Linux only runs UserData once, on
  first boot, so redeploying this stack alone does NOT propagate a new
  domain to an already-running instance - the instance's nginx config and
  `/etc/sysconfig/grafana-server`, plus the Cognito client, need to be
  updated separately (done here via SSM Run Command and
  `cognito-idp update-user-pool-client` rather than a stack redeploy).
- Deployed live: requested and DNS-validated an ACM certificate for the
  custom domain via the existing Route 53 zone, redeployed
  `uk-clearing-advisor-grafana-front`, added a Route 53 Alias A record
  (not a plain CNAME, targeting CloudFront's fixed hosted zone ID
  `Z2FDTNDATAQYW2`), updated the Cognito app client's callback/logout URLs
  to include the new domain (kept the old CloudFront domain and nip.io
  entries too, so neither breaks), and reconfigured the running instance
  via SSM (confirmed `nginx -t` passed, both `nginx` and `grafana-server`
  restarted and reported `active`).
- The account-specific domain name and certificate ARN are recorded in
  `DEPLOYMENT.md` (local, git-ignored), consistent with how the main
  site's custom domain was handled.

## 2026-07-29

### Added - optional custom domain for the CloudFront distribution
- `stacks/cdn.yaml` gained two optional parameters, `DomainName` and
  `CertificateArn`, both defaulting to empty so existing deployments are
  unaffected unless explicitly opted in. When `DomainName` is set, the
  distribution gets an `Aliases` entry and an ACM-backed `ViewerCertificate`
  (SNI, `TLSv1.2_2021` minimum) instead of the default CloudFront
  certificate.
- This is a CloudFront platform requirement, not a design choice: CloudFront
  will not serve a custom alternate domain name without an attached, valid
  ACM certificate covering that domain (certificate must live in
  `us-east-1` regardless of the stack's own region) - there is no "custom
  domain over plain HTTP, no certificate" option available on CloudFront.
- Deployed live: requested and DNS-validated an ACM certificate for
  `clearing.mehrs.net` via the existing Route 53 hosted zone, redeployed
  `uk-clearing-advisor-cdn` with the new parameters, and added a Route 53
  Alias A record (not a plain CNAME - resolves without an extra DNS lookup,
  targeting CloudFront's fixed hosted zone ID `Z2FDTNDATAQYW2`) pointing the
  domain at the distribution.
- Verified the redeploy did not reset `ApiOriginSecret` to its template
  default by reading the live distribution's origin custom header back
  after the update - it was preserved correctly (`aws cloudformation
  deploy` uses the template default for any parameter not explicitly
  passed, unlike `update-stack --use-previous-parameters`, so this was
  worth checking rather than assuming).
- Verified end-to-end from a real UK browser: correct TLS certificate,
  correct page content, geo-restriction still enforced (an earlier check
  from a container with a different network egress path was blocked, which
  turned out to be that container's own routing, not a CloudFront GeoIP
  misclassification - confirmed by comparing `ifconfig.co/country` against
  `checkip.amazonaws.com` from within it).
- The account-specific domain name and certificate ARN are recorded in
  `DEPLOYMENT.md` (local, git-ignored - not committed, matching how every
  other account-specific ID in this project is handled).

## 2026-07-28

### Added - scraper drift alarms and dashboard visibility
- `DailyScraper` has published `ScraperRunCount`, `ScraperChangesDetected`
  and `ScraperErrorCount` via `PutMetricData` since the Results Day ramp-up
  work, but none of the three appeared on either CloudWatch dashboard - the
  data existed but was invisible day to day.
- Added two widgets to `ClearingAdvisor-Operations`
  (`stacks/observability.yaml`): "Scraper: changes detected per run" and
  "Scraper: runs vs errors", both hourly Sum over the existing metrics.
- Added `ClearingAdvisor-ScraperDriftHigh` (threshold 15 changes in a
  rolling 6h window) and `ClearingAdvisor-ScraperErrorRate` (threshold 10
  errors/hour) - both notify-only via the existing `AlertsTopic` SNS topic,
  same pattern as every other alarm in this stack. Thresholds are a first
  pass calibrated against the real 24-28 Jul baseline (0-10 changes/day at
  the current hourly ramp-up cadence) and are flagged as worth revisiting
  once the 15-minute Results Day schedule takes over on 13 Aug.
- Deliberately did NOT build auto-adjustment of the scrape frequency in
  response to the drift alarm. Considered and rejected: would need a
  Lambda with `scheduler:UpdateSchedule` to rewrite
  `RampUpScraperSchedule`'s `rate()` expression, and a higher check
  frequency feeding back into more detected "changes" (including from a
  university rate-limiting the scraper - see the two-persistent-errors
  investigation below) risks an oscillating feedback loop. A human
  deciding whether to manually shorten the interval is safer.
- Wired both new alarms into `ClearingAdvisor-ResultsDay`'s existing
  "Active alarms" widget.
- Investigated the ~2 errors/run seen on every `DailyScraper` invocation
  since 22 Jul: correlates with University of Cambridge and Coventry
  University being the only 2 of 44 contacts with no `lastAutomatedCheck`
  ever recorded. Lambda logs show a Node `undici`
  `AssertionError: assert(!this.paused)` on stream teardown. Not yet fixed
  - flagged for follow-up. Cambridge's own seeded `notes` field already
  states it does not enter UCAS Clearing, so it may not be worth scraping
  regardless.
- Deployed live and verified: both alarms exist in the account
  (`ScraperDriftHigh` in `INSUFFICIENT_DATA` pending its first full 6h
  window, `ScraperErrorRate` `OK`), and `get-dashboard` on
  `ClearingAdvisor-Operations` confirms the new widgets are present.

### Added - front-page freshness indicator (student-facing)
- Considered publishing the raw scraper "changes detected" count on the
  public site, then rejected it: that count is an engineering signal built
  on a text-heuristic that can false-positive (see the Cambridge/Coventry
  errors above), and a student under Clearing pressure can't act on "31
  changes this week" - it doesn't tell them whether to trust the specific
  status badge in front of them. Freshness ("checked X minutes ago") is the
  honest, useful version of the same underlying signal.
- Added a live hero-section stat ("Checked X ago" / "clearing pages checked
  automatically") computed client-side in `frontend/app.js` from the
  existing `/api/universities` route's `lastAutomatedCheck` field - no new
  backend endpoint. Falls back to a static "Hourly" label if the fetch
  fails, so it never blocks page load.
- Added a per-course "Clearing page checked X ago" line next to each
  status badge in `courseCard()`, turning amber (reusing the existing
  `.warn`/amber colour token) when that university's `possibleStatusChange`
  flag is set - shown at the exact point a student decides whether to
  trust the badge before calling.
- Hero stats grid changed from a 3-column to a 2x2 layout
  (`frontend/styles.css`) to fit the new stat without cramping the
  existing three on narrow screens.
- Deployed live: synced to the static site S3 bucket and invalidated
  CloudFront (distribution `E1GGDJ3Q7WHJFP`, invalidation
  `I1D2DGY1AGKDM4LNKA9Q3BM0XY`, confirmed `Completed`). Verified by reading
  the deployed `index.html`/`app.js`/`styles.css` back directly from the
  S3 origin (CloudFront's GB geo-block prevented a direct browser-equivalent
  check from this non-UK host, same limitation noted in earlier entries).
- Committed on branch `scraper-observability-and-freshness-ui`
  ([PR #1](https://github.com/usmanmehr/uk-clearing-advisor/pull/1)) rather
  than direct to `main`, since the change was already deployed live ahead
  of the PR - merging brings `main` in sync with production rather than
  triggering a new deploy.

## 2026-07-25

### Added - daily OS patching for the Grafana instance
- Added `stacks/patching.yaml`: an SSM Patch Manager setup for the Grafana
  EC2 instance - a custom patch baseline (Security + Bugfix
  classifications, Critical/Important severity, matching AWS's own
  default AL2023 baseline filters but with `ApproveAfterDays: 0` instead
  of AWS's default 7, so security patches apply the same day they're
  released), a daily Maintenance Window (`cron(0 7 ? * * *)`, 07:00 UTC),
  and an `AWS-RunPatchBaseline` Run Command task with `RebootIfNeeded`.
  Additive-only stack - does not modify `stacks/grafana.yaml` or any
  existing instance configuration.
- The target instance requires a `Patch Group=clearing-advisor-grafana`
  tag to actually use this custom baseline instead of the account's
  separately-managed default AL2023 baseline (an existing
  `AWSSupportPatchwork-AmazonLinux2023PatchBaseline`, unrelated to this
  change). CloudFormation cannot apply this tag itself, since the
  instance is defined in a different stack - applied manually via
  `aws ec2 create-tags` and documented as a required step in `DEPLOY.md`.
- Verified filter values against the account's actual live default
  AL2023 baseline (`aws ssm get-patch-baseline`) rather than assuming
  documented example values.
- Deployed live and verified: the tag is present on the instance, the
  Maintenance Window is `Enabled` with the correct schedule and a real
  `NextExecutionTime` of the following day at 07:00 UTC.
- Not deployed automatically by `deploy.sh` - this targets a specific
  already-running instance ID rather than infrastructure created fresh
  on every deploy, so it's a separate, documented, optional step.

### Added - basic SEO/discoverability (no cookies, no tracking)
- Cookies were considered and rejected as a promotion mechanism: they only
  recognise a browser already on the site (logins, preferences), not
  attract new visitors - and adding any beyond strictly-necessary ones
  would contradict the site's own "no personal data collected" footer
  claim and trigger UK PECR cookie-consent banner obligations for no
  benefit. Implemented actual discoverability improvements instead.
- Added `robots.txt` (allow all crawlers, points to the sitemap) and
  `sitemap.xml` (single entry - this is a client-side single-page app with
  no separate crawlable result pages, so one URL is correct, not
  incomplete).
- Added Open Graph and Twitter Card meta tags to `index.html` so links
  pasted into Reddit/WhatsApp/social get a proper title+description
  preview card instead of a bare URL - relevant since the planned
  promotion route (Reddit communities like r/UniUK, r/UCAS around Results
  Day, plus social/advisor sharing) depends on links being shared, not
  typed. No image/thumbnail added yet (none exists in the repo). Also
  added a canonical `<link>` tag.
- Deployed live to S3, CloudFront invalidated, verified all three files
  (index.html, robots.txt, sitemap.xml) match on the S3 origin directly.

## 2026-07-24

### Added - legal notice in the footer
- Added a short, plain-language legal notice below the existing data-source
  disclaimer: this is an independent, non-commercial project built as a
  genuine effort to help students; no responsibility is accepted for the
  accuracy of any information shown; users should verify course
  availability and offers directly with UCAS and the university; no fee
  or profit is made from this service.
- Frontend-only change (index.html, styles.css) - no architecture or
  infrastructure impact, so the diagram and ARCHITECTURE.md are unaffected.

### Fixed - mobile usability (responsive CSS, not device detection)
- Considered and deliberately rejected User-Agent-based device detection
  for serving different markup to phones vs desktops: UA strings are
  unreliable/spoofable, the site is served from S3 via CloudFront with
  `CachingOptimized` (efficient, cheap caching that per-device HTML would
  complicate or defeat), it doubles the markup to maintain forever, and it
  doesn't react to window resizing, split-screen, or orientation change
  the way real responsive CSS does. Fixed with viewport-width media
  queries instead - the app already had a viewport meta tag and some
  breakpoints, but they had real gaps.
- Touch targets: buttons, the "Remove" A-level button, and the checkbox
  now meet the ~44px minimum comfortable tap size (Apple/Google
  guidance) - several were previously ~32-35px, easy to mis-tap on a
  phone.
- Added `touch-action: manipulation` on interactive elements to remove
  the ~300ms double-tap-to-zoom delay some mobile browsers still apply.
- Text inputs/selects now have `min-height: 44px` and stay at 16px+ font
  size, which also prevents iOS Safari's automatic zoom-on-focus that
  otherwise jars the layout every time a field is tapped.
- Added a `640px` breakpoint (between the existing `860px` and `520px`
  ones) to compress the hero section on phones specifically - it was
  previously sized for tablet-width screens at that range, pushing the
  actual search form further down the page than necessary on a typical
  phone.
- Fixed the A-level subject/grade/remove row at narrow phone widths
  (<520px): it was a cramped 3-column grid that squeezed the subject
  text input uncomfortably; now the Remove button drops to its own row
  instead of shrinking the input further.
- Added `overflow-x: hidden` on `body` as a guard against any accidental
  horizontal scroll on narrow viewports, and `-webkit-text-size-adjust:
  100%` so mobile browsers don't auto-inflate text size unpredictably.

### Added - one-command deploy script + deployment guide
- Deploying this project previously meant running ~10 separate `aws`
  commands by hand, in a specific order, while manually fetching or
  inventing the CloudFront<->API shared secret and remembering to rebuild
  Lambda zips before every compute deploy. None of that is inherent to
  CloudFormation - it was just undocumented sequencing - so it's now
  wrapped in a single script rather than requiring a switch to a different
  IaC tool.
- Added `deploy.sh`: checks AWS CLI auth, packages and uploads Lambda zips,
  deploys `data` and seeds it, deploys `compute` (generating the shared
  X-Origin-Verify secret on first run and safely reusing the same one on
  every re-run by reading it back from the live `GetSubjects` function),
  deploys `api`, `waf` (us-east-1), `cdn`, syncs the frontend, invalidates
  CloudFront, then re-deploys `api` a second time with the real CloudFront
  domain as `AllowOrigin` (fixes a real gap: `AllowOrigin` previously
  defaulted to a placeholder and was never actually tightened in the
  documented manual sequence).
- `--full` additionally deploys `observability`, `scaling`, and the
  two-pass `grafana` / `grafana-front` sequence (Grafana needs the
  front door's CloudFront domain, which doesn't exist until Grafana's own
  Elastic IP exists first - handled automatically, previously a manual
  "deploy once with a placeholder, note the domain, redeploy" step).
- Added `DEPLOY.md`: prerequisites (with why each one is needed, not just
  a bare list), the two-tier core/`--full` deploy flow, what every
  environment variable is for and how to find its value, re-run/update
  guidance, a full reverse-order teardown sequence, and a troubleshooting
  table for the failure modes actually hit while building and testing this
  (auth not configured, CloudFront's genuine 5-15 min deploy time, geo-block
  looking like a bug, `ROLLBACK_COMPLETE` diagnosis, non-public Grafana
  subnets).
- Verified: `bash -n` and `shellcheck` both pass clean on `deploy.sh`, and
  the credential-check preflight was tested directly (invalid
  `AWS_PROFILE` produces the intended clear error and exits before any AWS
  resource calls, rather than failing confusingly partway through).
- Updated `README.md` and `ARCHITECTURE.md` to point new users at
  `deploy.sh` / `DEPLOY.md` instead of the old inline multi-command
  snippets (which are now removed from README to avoid two conflicting
  sources of deploy instructions).

### Added - cost dashboard (tag-based, in the existing Grafana)
- Made the infrastructure cost visible on a dashboard. This AWS
  account is not dedicated to this app - it also runs other unrelated
  stacks/workloads - so account-level billing (e.g. the `AWS/Billing`
  CloudWatch metric) would be meaningless for "cost of this app" without
  isolating it first.
- Tagged every resource in all 9 `uk-clearing-advisor-*` CloudFormation
  stacks (7 in eu-west-2, plus `grafana-front` and `waf` in us-east-1,
  since CLOUDFRONT-scope WAF resources are us-east-1-only) with
  `Application=uk-clearing-advisor` / `Environment=production` via
  stack-level `Tags`, which cascades to every taggable resource
  automatically - no per-resource template edits needed. Verified the tag
  actually landed on a real resource (`ClearingAdvisor-DailyScraper`'s
  Lambda tags), not just at the stack level.
- Activated `Application` as a Cost Allocation Tag
  (`ce:UpdateCostAllocationTagsStatus`) so Cost Explorer can filter to
  just this app's spend. Note: AWS can take up to 24h to backfill a
  newly-activated tag into Cost Explorer's queryable data - the dashboard
  will read `0` until that propagation finishes.
- Added `ClearingAdvisor-CostReporter`, a small daily Lambda
  (`cron(0 6 * * ? *)`, after Cost Explorer's own ~24h reporting lag)
  that calls `ce:GetCostAndUsage` filtered to that tag for the previous
  day and publishes the result as a CloudWatch metric
  (`ClearingAdvisor/DailyCostUSD`). `ce:GetCostAndUsage` doesn't support
  resource-level IAM scoping, so its policy is necessarily `Resource: '*'`
  (documented in the template) - it's read-only.
- Added two panels to the existing `grafana/dashboard.json` (already
  deployed on this project's own Grafana-on-EC2, which already had a
  CloudWatch datasource provisioned - no new datasource, plugin, or
  separate Grafana instance needed): a stat panel for yesterday's cost
  and a 30-day trend, both reading `DailyCostUSD`. Deployed the updated
  dashboard to the live instance via S3 sync + SSM `RunShellScript`
  (`AWS-RunShellScript` document) rather than SSH, matching the existing
  admin-access pattern (the instance only allows SSM Session Manager and
  a locked-down HTTPS CIDR, no open SSH).
- Fixed a self-inflicted delay found while testing: the metric was
  initially timestamped with the cost period's own date (yesterday)
  rather than "now" (publish time). CloudWatch can take up to 48h to
  make a data point queryable once its timestamp is more than 24h old -
  backdating it would have added ~2 extra days on top of Cost Explorer's
  own lag for no reason. Fixed to timestamp "now" while the *value*
  still reflects yesterday's spend; verified via a manual `put-metric-
  data` test with each timestamp style that this was the actual cause
  before changing the code.
- Verified live: `CostReporterFunction` invokes successfully (Cost
  Explorer's `client-cost-explorer` SDK package is bundled in the
  Node.js 22 Lambda runtime - confirmed by invoking directly rather than
  assuming), publishes to `ClearingAdvisor/DailyCostUSD`, and the metric
  is queryable via `cloudwatch get-metric-statistics` within about a
  minute of publish. Account-wide (untagged) Cost Explorer confirmed real
  spend exists for the same day, ruling out a query-construction bug as
  the reason the tag-filtered number currently reads 0.

### Added - hourly scraper ramp-up ahead of Results Day
- The 15-minute Results Day rule (`ClearingAdvisor-ResultsDayScraper`)
  only fires on 13 Aug 2026 itself. The ~3 weeks beforehand (24 Jul-12 Aug)
  were still only checked once a day at 07:00 UTC, even though universities
  can and do update Clearing pages ahead of Results Day.
- Added `ClearingAdvisor-RampUpScraper`, a new `AWS::Scheduler::Schedule`
  (Amazon EventBridge Scheduler, not the classic `AWS::Events::Rule` cron
  used elsewhere in this stack) that runs the same `DailyScraper` function
  every hour, bounded by a real `EndDate` of 2026-08-12T23:59:00Z so it
  stops automatically the day before Results Day - no manual disabling
  needed, and it can never run forever by accident. A classic cron rule
  has no native end date, which is why Scheduler was used here instead.
- Added `RampUpScraperSchedulerRole`, a dedicated IAM role assumed by
  `scheduler.amazonaws.com` to invoke `DailyScraper`, with a
  confused-deputy hardening condition (`aws:SourceAccount` +
  `aws:SourceArn` scoped to the `default` schedule group, per AWS's
  documented guidance) restricting which schedules may assume it.
- Neither existing schedule was touched: `DailyScraperSchedule` (07:00 UTC,
  year-round) and `ResultsDayScraperSchedule` (15-minute, 13 Aug only)
  are unchanged. No code change to `DailyScraper` itself - same reasoning
  as the Results Day rule: it's idempotent, so a higher check frequency
  only narrows the detection window.
- Verified live via `scheduler get-schedule`: `State=ENABLED`,
  `ScheduleExpression=rate(1 hour)`, `EndDate=2026-08-12T23:59:00+00:00`,
  target is `ClearingAdvisor-DailyScraper` via the new scheduler role.
  Confirmed both pre-existing rules are still `ENABLED` with their original
  schedule expressions after the deploy.
- Flagged, not acted on: hourly checks across 44 universities for ~3 weeks
  is a real, sustained volume of outbound requests to other institutions'
  servers (tens of thousands of requests total). Worth revisiting if any
  university's Clearing page starts rate-limiting or blocking the scraper.

## 2026-07-23

### Changed - architecture diagram brought up to date
- `architecture.dot`/`.png`/`.svg` had drifted from the live system after
  this session's changes and no longer reflected: the new `Health` Lambda
  and its `/health` route, the `X-Origin-Verify` secret check now enforced
  on every API-facing Lambda, the new `ResultsDayScraper` EventBridge rule,
  `DailyScraper`'s tightened heuristic and its new write-back to
  `UniversityContacts` (previously read-only), the eighth CloudWatch alarm
  (`SearchDurationAlarm`), and a stale `SearchCourses-v4.zip` version label.
  Regenerated the PNG/SVG from the corrected `.dot` source with Graphviz.

### Added - Results Day scraper runs every 15 minutes
- `DailyScraper` previously ran once a day (07:00 UTC) year-round. On a
  normal day that's a reasonable cadence, but on Results Day a university
  can open, close and reopen Clearing vacancies multiple times within a
  few hours - a once-daily check would miss all of that and could leave
  `possibleStatusChange` unset even though the page genuinely changed and
  changed back before the next check.
- Added a second, time-bounded EventBridge rule
  (`ClearingAdvisor-ResultsDayScraper`) that runs the same `DailyScraper`
  function every 15 minutes from 04:00 to 20:00 UTC, but only on 13 Aug
  2026 - matching the existing `ScaleUp`/`ScaleDown` window in
  `stacks/scaling.yaml` exactly, so the higher-frequency check is active
  for the same period the infrastructure is already scaled up for Results
  Day traffic. No code change to `DailyScraper` itself - it's idempotent
  (compares against the last stored scrape state each run), so running it
  more often only narrows the detection window, it doesn't change the
  logic. The year-round daily cadence is unchanged; this doesn't need
  manual disabling afterwards since the rule is scoped to a single date.
- Verified live: the rule is `ENABLED` with schedule
  `cron(0/15 4-20 13 8 ? 2026)` and targets the existing
  `ClearingAdvisor-DailyScraper` function (confirmed via
  `events describe-rule` / `list-targets-by-rule`), and the cron expression
  itself was validated by AWS EventBridge directly (created and then
  deleted a throwaway test rule with the same expression) before being
  committed to the template.

### Added - student-experience and reliability improvements
Reviewed the app from two angles: as a student trying to find a Clearing
course under pressure, and as the systems engineer responsible for speed
and accurate information. Implemented every improvement identified,
verified UCAS Tariff points against Pearson's official table before
touching any grading logic.

**Data accuracy - closing the biggest gap found**
- `DailyScraper` detected real changes to university Clearing pages daily
  but the result never reached students - the status badge could be
  silently stale. Now writes `lastAutomatedCheck` and `possibleStatusChange`
  to each university record after every run. `possibleStatusChange` is only
  ever set to `true` by the scraper (never cleared back to `false` by it) -
  it stays flagged until a human re-seeds the data, so a detected drift
  can't quietly disappear before anyone reviews it. `SearchCourses` now
  returns these fields, and course cards show an explicit "automated check
  flagged a possible change - confirm directly" warning when set.
  `scripts/seed.py` writes a fresh `lastVerified` timestamp on every re-seed
  (a full re-seed is what counts as a human-verified refresh).
- Tightened the scraper's change-detection heuristic: previously a single
  mention of the word "clearing" anywhere on a page counted as a signal
  (a stray footer/nav link could trigger a false positive). Now requires
  either more than one mention, or an explicit open/closed phrase
  ("clearing is now open", "no vacancies", "fully booked", etc).
- Recalibrated grading from an arbitrary internal 7-12 points-per-grade
  scale to the real, published UCAS Tariff (A\*=56, A=48, B=40, C=32,
  D=24, E=16 - verified directly against Pearson's official BTEC/A-level
  tariff table and cross-checked against two independent sources). Offer
  thresholds recalibrated to match (BBB=120, ABB=128, AAB=136, AAA=144,
  A\*AA=152). Scoped to A-levels only; other qualification
  types (IB, BTEC) were investigated and verified on the same points scale
  but deliberately not added to keep scope to A-levels.

**Speed and reliability**
- Added a dedicated `/health` endpoint (new `Health` Lambda) for synthetic
  monitoring - previously the only way to know the API was up was to run
  a real search. Deliberately does not require the shared origin secret
  (external monitors need direct access) and does a cheap DynamoDB
  connectivity check.
- Added `SearchDurationAlarm` (CloudWatch, `AWS/Lambda` `Duration` p99 over
  2 evaluation periods) so a real speed regression - e.g. the DynamoDB scan
  slowing down as the dataset grows - is caught directly, complementing the
  existing request-count-based `SlowSearchAlarm`.
- Added a regression test suite (`lambda/shared/shared.test.mjs`, Node's
  built-in test runner, zero dependencies) covering the grading logic,
  including an explicit regression test for the 2-subject-normalisation
  fix from earlier this session. Wired into CI (`lambda-tests` job,
  Node 22) alongside the existing `cfn-lint` job.

**Student-facing UX**
- The submit button now disables and shows "Searching..." while a request
  is in flight, so a double-tap on a slow connection can't fire two
  searches and burn the rate limit for nothing.
- Added a 12-second client-side timeout (`AbortController`) with a
  distinct "taking longer than usual" message, instead of an indefinite
  spinner with no time bound.
- Zero-result searches now show actionable, context-specific guidance
  (e.g. "untick Russell Group only", "clear your course interest") instead
  of a generic dead end.
- Added client-side "did you mean [Subject]?" suggestions for mistyped
  course interests (e.g. "Buisness", "Comp Sci"), using a small local
  Levenshtein-distance check against the full subject list.
- Searches now update the address bar (via `history.replaceState`, so the
  back button isn't spammed) with the entered grades/subject/filters as
  query parameters, so a student can copy the link and send it to
  themselves or a parent. Opening such a link pre-fills the form but does
  NOT auto-run the search.

Deployed live and verified: `/health` returns `200` with a real DynamoDB
connectivity check; a live search response includes `lastAutomatedCheck`
and `possibleStatusChange`; the recalibrated BBB threshold still returns
the same 20 matches as before recalibration (cross-checked against the
pre-recalibration result from earlier this session); the new frontend
code (confirmed by direct S3 object inspection, since CloudFront's GB
geo-block prevented a direct check from this non-UK host) contains all
five new functions.

### Changed - per-IP rate limits raised (30/minute, 700/hour)
- `/search` per-IP rate limit raised from 10 requests/minute to 30/minute
  (verified live with a 32-request burst: requests 1-30 returned 200,
  31-32 returned 429, confirming the boundary).
- Hourly cap raised from 100/hour to 700/hour, so a real single-IP user
  isn't blocked by the hour window before the per-minute window would
  matter (30/min sustained now allows ~23 minutes before the hourly cap,
  vs under 4 minutes previously). The export limit (5 per 30 min) is
  unchanged.
- Deployed live (SearchCourses, published version 13) and verified by
  downloading the exact deployed code artifact from the live alias and
  confirming the `700` value is present in the running source, not just
  the deploy pipeline's reported success.

### Fixed - students with only 2 A-levels always got zero results
- Found while assessing whether the site is fit for purpose: the search
  form's own stated minimum is 2 A-levels, but `gradeTotal()` summed
  whatever grades were given without normalising for count. Offer
  thresholds are calibrated against 3 A-levels (BBB = 30 points minimum).
  Two subjects, even two A*s (24 points), could never reach 30 - so anyone
  with exactly 2 A-levels got zero results regardless of grades, silently.
- Fixed in `gradeTotal()` (`lambda/shared/shared.mjs`): average the best up
  to 3 grades, then scale to a 3-subject-equivalent total. For 3+ subjects
  the result is unchanged (average of top 3, times 3, equals the sum of
  top 3). For 2 subjects, the average is fairly compared against the same
  thresholds instead of being mathematically incapable of qualifying.
- Deployed live (SearchCourses v11) and verified: BB with 2 subjects now
  correctly matches BBB-threshold universities (20 matches, same result as
  BBB with 3 subjects); genuinely low 2-subject grades (BC) still
  correctly return zero, since no seeded university requires less than
  BBB-equivalent.

### Security - pen test fixes
- Ran a non-destructive penetration test against the live infrastructure
  (access control, injection, rate limiting, information disclosure,
  Grafana/admin surface). Full findings and what held up are in the pen
  test report; three gaps found and fixed here:
- **Missing security headers** - added a CloudFront `ResponseHeadersPolicy`
  (`stacks/cdn.yaml`) applying HSTS, a strict `Content-Security-Policy`
  (`default-src 'self'`, no `unsafe-inline`), `X-Frame-Options: DENY`,
  `Referrer-Policy`, and `X-XSS-Protection` to both the site and `/api/*`
  cache behaviours. Moved the honeypot field's inline `style` attribute
  into a CSS class (`.honeypot`) so the CSP could ship without
  `unsafe-inline` for styles.
- **Unbounded `subjects[]` array** - `/search` only checked for at least 2
  subjects, no upper bound; a 2000-item/500KB payload was accepted. Added
  a `MAX_SUBJECTS = 10` cap and a 100-character limit on individual subject
  names and `courseInterest`.
- **Grafana nginx version disclosure** - `server: nginx/1.30.3` was
  returned on every response. Added `server_tokens off;` to the nginx
  config in `grafana.yaml`'s user-data (for future instances) and applied
  the same change live via SSM to the running instance.
- All three verified live: CloudFront responses now carry the new security
  headers on both cache behaviours; a 50-subject payload is rejected with
  `A maximum of 10 A-level subjects is supported`; Grafana now returns
  `server: nginx` with no version number.
- Noted but out of scope: a real, active AWS access key was found in
  plaintext in the local `~/.aws/credentials`, `.bak`, and `.bash_history`
  files on the development host - confirmed NOT present anywhere in the
  git repository or its history. Workstation-local risk, not an
  application vulnerability; no changes made to the workstation.

### Security - close direct API Gateway bypass of WAF/geo-block
- The HTTP API was reachable directly at its `execute-api` URL, bypassing
  the CloudFront GB geo-restriction and WAF rules entirely (only the
  DynamoDB per-IP rate limit and CORS applied on that path). Flagged in the
  Well-Architected review as a Medium finding.
- Fixed using the same shared-secret pattern already used for the Grafana
  origin: CloudFront now sends an `X-Origin-Verify` header (via
  `OriginCustomHeaders` on the API origin, so it doesn't count against the
  10-header cap on the origin request policy) to every request it forwards
  to API Gateway. All five API-facing Lambdas (`SearchCourses`,
  `GetSubjects`, `GetUniversities`, `GetScholarships`, `GenerateExport`)
  now verify this header via a new `checkOriginSecret()` helper in
  `shared.mjs` and return `403 FORBIDDEN` if it's missing or wrong.
- `WarmUp`'s direct invoke of `SearchCourses` (bypasses API Gateway
  entirely) is unaffected - the `__WARMUP__` bypass is checked before the
  origin-secret check, since WarmUp never carries the header.
- Fails open only if `API_ORIGIN_SECRET` is not configured at all (so this
  is a no-op until deployed), fails closed (403) once configured.
- Deployed live and verified: direct calls to the `execute-api` URL without
  the header now return 403 on all five endpoints; the same call with the
  correct header returns a full 200 response, proving real UK traffic
  through CloudFront is unaffected.

### Changed - salary shown once per search, not per university
- Salary is a national subject median (HESA) - identical for every
  university in a given search, so repeating it on every course card
  overstated its precision and could be misread as a per-university figure.
  It is now shown once, in a banner above the results ("National median
  salary for Economics graduates: £35,750..."), with a link to the source.
- `POST /search` response now returns a top-level `salaryContext` object
  (subject, nationalMedianSalary, source, sourceUrl, year) instead of
  repeating `nationalMedianSalary` on every result. Ranking and the
  `minSalary` filter are unaffected - salary is still used internally, just
  not echoed per-result.
- `GenerateExport` (XLSX/PDF) prints the same salary note once at the top of
  the shortlist instead of a "National median salary" column repeated on
  every row.
- Per-university **graduate prospects** (Complete University Guide 2027)
  is unchanged and still shown on every card - it genuinely varies by
  university, unlike salary.
- Deliberately did NOT attempt to show real per-university salary
  differences (e.g. Oxbridge vs other universities) - no verified
  per-university, per-subject salary dataset is loaded yet. Doing this
  properly needs the Discover Uni API or DfE LEO provider-level data
  (see Option 1/2 in the earlier data-correction notice), not an estimate
  from the single anecdotal figure available.

### Fixed - Well-Architected review follow-up
- **Security**: API Gateway CORS was still `AllowOrigins: ["*"]` in production,
  even though the CloudFront app domain has existed since launch. Since the
  API is also reachable directly via its `execute-api` URL, this allowed any
  website to call `/search` cross-origin. Locked `AllowOrigin` to the live
  CloudFront domain in `stacks/api.yaml` and redeployed; verified via a CORS
  preflight request that only the app's own origin is now allowed.
- **Operational Excellence**: `stacks/compute.yaml` had drifted from the live
  `SearchCourses` Lambda - several hotfixes this session (outcome-data
  accuracy, no-caching, search-insight logging) were deployed directly via
  the CLI and were not reflected in the template's `S3Key`/version. Bumped
  the template to reference the current code (`SearchCourses-v7.zip`) so a
  future `cloudformation deploy` reconciles state instead of reverting it.
  Verified the `live` alias still resolves to the same running code after
  the reconciling deploy.

### Added
- Grafana now surfaces what students are actually searching for, not just
  where they are searching from. `SearchCourses` logs a structured
  `subjectsEntered` field (e.g. `Mathematics:A, Physics:A, Chemistry:B`)
  plus the selected sort priority, location filter and Russell-Group-only
  flag on every search.
- Four new dashboard panels in `grafana/dashboard.json`:
  - **Top course interests** - most-searched subjects/courses.
  - **What people are searching for, by region** - course interest
    cross-tabulated with UK region, so you can see, for example, that
    Manchester searches skew towards Computer Science.
  - **A-level subjects and grades entered** - the actual subject/grade
    combinations students are typing in.
  - **Average grade points by region** - typical predicted/achieved
    grades by UK region.
  - Deployed to the live Grafana instance and verified end-to-end with a
    live search (Manchester, Computer Science, Maths A / Physics A /
    Chemistry B) confirmed flowing through to the new log fields.

### Removed
- All response caching removed from the API and frontend. Clearing status,
  hotline hours and outcome data can change within the hour on Results Day,
  so every request now fetches live from source instead of a cached copy:
  - `SearchCourses` no longer keeps university/subject reference data in
    memory across warm Lambda invocations (previously cached 5 minutes).
  - `GetUniversities` and `GetScholarships` no longer send a 1-hour
    `Cache-Control: public, max-age=3600` header.
  - `GetSubjects` no longer sends a 1-week `Cache-Control` header.
  - Frontend `fetch` calls to `/search` and `/subjects` now set
    `cache: 'no-store'` as a second line of defence against browser caching.

### Fixed
- `GenerateExport` (PDF/XLSX shortlist download) referenced the old
  `salary15months` / `employabilityRate` field names after the outcome-data
  rename below, which would have silently printed blank figures in exported
  shortlists. Updated to `nationalMedianSalary` / `graduateProspects`, and
  added source/year context to both export formats.

### Changed - outcome data accuracy
- Salary is no longer implied to be a university-specific figure. It is
  now clearly labelled as the **national median for the subject** (HESA
  Graduate Outcomes 2022/23, via Prospects Luminate), shown only when a
  course interest resolves to a known subject, with source URL and data
  year attached to every result.
- Employability is no longer a national subject-level rate applied to every
  university. It is now the verified **per-university Graduate Prospects %**
  from the Complete University Guide 2027, seeded for the 10 universities
  with a published figure (Bath, LSE, Warwick, King's College London,
  Exeter, Durham, Edinburgh, Manchester, Leeds, Queen Mary). Universities
  without a verified figure show no employability percentage rather than
  an estimate.
- Business and Management national median salary corrected to £30,190 to
  match the verified HESA figure (was £30,000).
- Ranking/sorting and the `minSalary` / `minEmployability` filters made
  null-safe for universities with no verified graduate prospects figure.
- Frontend result cards, "Good to know" panel and footer disclaimer updated
  to describe salary and graduate prospects accurately, with inline source
  links.

## 2026-07-22

### Added
- Initial public release: serverless UK Clearing Advisor on AWS
  (eu-west-2 for compute/data, us-east-1 for WAF), covering search,
  university/subject browsing, XLSX/PDF export, daily clearing-page
  scraper, Results Day warm-up and auto-scaling, and CloudWatch/Grafana
  analytics.
- CI workflow running `cfn-lint` on CloudFormation templates.
- Contributing guide, issue and PR templates, CI status badge in the README.
- "Deploy your own" quickstart and branch protection guidance in the docs.

### Fixed
- Grafana dashboard panels had no datasource set on their targets, so
  panels rendered empty on Grafana 11+. All panel targets now explicitly
  reference the CloudWatch datasource.
- Grafana served through the CloudFront front door returned
  `403 "origin not allowed"` on cookie-authenticated queries, because the
  browser's `Origin` (the CloudFront domain) didn't match what Grafana
  saw via the nginx-forwarded `Host` (the EC2 nip.io address). Baked the
  fix into `stacks/grafana.yaml`: nginx now forwards the CloudFront domain
  as `Host`/`X-Forwarded-Host`, and `GF_SERVER_ROOT_URL` /
  `GF_SECURITY_CSRF_TRUSTED_ORIGINS` are set to match.

### Changed
- License updated.

## 2026-07-30 (3)

### Changed - DEPLOYMENT.md rewritten, account-specific values split out
- `DEPLOYMENT.md` had drifted from live state: it still listed the custom
  domain as "not yet deployed" a week after both the app's and Grafana's
  custom domains actually went live (2026-07-29 entries), and several other
  sections (alarm count, scraper schedule count, dashboard panel list) had
  fallen behind the same way. Since it's git-ignored (deliberately, to keep
  live account IDs/domains out of a public repo), nothing catches this drift
  automatically - it only gets fixed when someone happens to reread it.
- Re-verified every claim in the doc directly against live AWS state rather
  than trusting the previous text: ran `aws cloudformation describe-stacks`
  against all 10 stacks (both regions), confirmed stack status is
  `*_COMPLETE` on every one, and pulled real output/parameter values (custom
  domains, certificate ARNs, distribution IDs, security group ID, Cognito
  user pool ID, admin email). Also found and documented a real, previously
  unstated fact: the `CUGRankings` and `Scholarships` DynamoDB tables both
  currently hold 0 items (confirmed via `aws dynamodb scan --select COUNT`)
  - the ranking/scholarship code paths are live against genuinely empty
  tables, not placeholder-but-populated data.
- Split account-specific values (account ID, region, custom domains,
  certificate ARNs, CloudFront distribution IDs, bucket names, security
  group ID, Cognito pool ID, admin email) out of `DEPLOYMENT.md` into a new
  `clearing.env` file, added to `.gitignore`'s existing (unused until now)
  reference to that exact filename. `DEPLOYMENT.md` now describes *what's
  deployed and when* and references `clearing.env` for *the actual current
  values*, instead of duplicating both in one doc that has to stay
  consistent with itself as well as with reality. This doesn't fix the
  root cause (nothing enforces re-verification before a doc update), but it
  does mean a future update only has to change one file, not find and
  update the same value in two places.
- Did not change `DEPLOY.md` - it's the public, generic deployment guide
  and correctly uses placeholder values throughout (`<your-account-id>`,
  `vpc-xxxxxxxx`, etc.), not real ones, so it wasn't part of the drift
  problem this addresses.

## 2026-07-30 (4)

### Fixed - inaccurate "no data collected" claims removed from the frontend
- `frontend/index.html` claimed in five places that no personal data is
  collected / stored / tracked ("All fields stay on your device. Nothing is
  stored against you.", "No sign-up. No personal data collected.", "No
  personal data is collected.", "Plain data, no tracking.", plus the same
  wording duplicated into the `og:description`/`twitter:description` meta
  tags). This isn't true: `SearchCourses` (`lambda/SearchCourses/index.mjs`)
  logs a masked source IP, CloudFront-derived geolocation
  (country/region/city/lat/lon), device type, and user agent on every
  search, and `GenerateExport` logs a masked IP on every export. All of it
  goes to CloudWatch Logs and feeds the Grafana geomap/device dashboards.
- Removed all five claims rather than rewording them into an accurate
  privacy statement, per explicit instruction - a proper accounting of what
  is/isn't logged (masked IP, geo, device, UA, retention periods) belongs in
  a real privacy note if one gets written later, not squeezed into hero
  copy. The surrounding sentences were kept ("No sign-up" stays true) so the
  copy still reads naturally.
- No functional/logging change - this is a copy-accuracy fix only.

## 2026-07-30 (5)

### Fixed - removed weak placeholder template defaults on shared origin secrets
- `stacks/compute.yaml`, `stacks/cdn.yaml`, and `stacks/grafana.yaml` each
  had a short, static placeholder string as the `Default` on their
  `ApiOriginSecret`/`OriginSecret` parameter. `deploy.sh` always generates
  and passes a real secret
  explicitly, so this was never live in production, but a deploy that
  forgot to pass the parameter (a manual `cloudformation deploy`, a
  staging clone, a typo dropping `--parameter-overrides`) would have
  silently fallen back to a guessable literal string instead of failing.
  Removed the defaults (now required, `MinLength: 20`) so a forgotten
  override fails the deploy loudly instead of quietly opening the
  CloudFront-bypass check. `stacks/grafana-front.yaml`'s `OriginSecret`
  already had no default - the other three now match it.
- Rotated the live app-pair secret (`compute` + `cdn` stacks) to a fresh
  64-char hex value, verified live: the new value matches exactly across
  the `GetSubjects` Lambda's env var and the CloudFront distribution's
  `X-Origin-Verify` origin custom header after both stacks redeployed.
- Did NOT rotate the Grafana-pair secret (`grafana` + `grafana-front`
  stacks) in this pass. Checking the live `grafana` stack found it has
  real structural drift from the current `stacks/grafana.yaml` template -
  `aws cloudformation get-template-summary` shows the deployed stack has
  no `OriginSecret`/`FrontDomain` parameters at all, because the
  2026-07-29 (2) custom-domain work was applied by hand via SSM directly
  to the running EC2 instance, not through a stack update (documented at
  the time). Running `cloudformation deploy` against a stack that far out
  of sync with its own template risks CloudFormation replacing the EC2
  instance to reconcile it, which would mean real Grafana downtime for a
  parameter-only change - deliberately deferred rather than risked without
  a reviewed change set first.

### Changed - Grafana dashboard panel order
- Moved "Geo-blocked requests (non-UK) - WAF" and "Security blocks over
  time (WAF rules)" to the bottom of `grafana/dashboard.json`, below the
  usage/qualification-path panels, per feedback that security/WAF metrics
  are lower-priority for day-to-day reading than usage data. Every panel
  below the old slot shifted up 8 grid units to close the gap; verified
  the resulting layout has no y-overlaps or gaps before deploying.
- Considered "by county" for "Requests by UK region" and "What people are
  searching for, by region" (also requested) and did NOT implement it -
  checked live production log data via CloudWatch Logs Insights and
  confirmed CloudFront's viewer geolocation headers only resolve to UK
  *nation* (England/Scotland/Wales/Northern Ireland) for the region field,
  not county. Relabelling the existing panels "by county" would have
  mislabelled the same nation-level data. A real county breakdown would
  need either a city-to-county lookup table or lat/lon-to-boundary
  matching added on top of the existing geoCity/geoLat/geoLon fields -
  scoped as a separate future addition, not folded into a panel reorder.
- Deployed live via the established pattern (S3 upload + SSM
  `AWS-RunShellScript` on the Grafana EC2 instance, since `dashboard.json`
  only loads at boot) - verified `Status: Success` and Grafana restarted
  `active`.

### Changed - WELL-ARCHITECTED.md: reclassified the Grafana origin finding
- The review previously listed the CloudFront-to-Grafana HTTP origin
  under Security "Good" (as a documented, deliberate compromise). Moved
  it to "Risk" as **H2**: admin cookies and the origin secret cross the
  CloudFront-to-EC2 hop as plaintext HTTP, since CloudFront requires a
  CA-trusted certificate for HTTPS custom origins and the instance's only
  reachable hostname is a self-signed `nip.io` wrapper.
- Evaluated two real fixes: AWS CloudFront VPC Origins (GA Nov 2024,
  confirmed available in this account/region via
  `aws cloudfront list-vpc-origins` and the `AWS::CloudFront::VpcOrigin`
  CloudFormation resource) would need the instance moved to a private
  subnet plus a NAT Gateway or VPC endpoints for outbound traffic - a real
  architecture change and ongoing cost, rejected as disproportionate for
  infrastructure that runs a few weeks a year. A Let's Encrypt certificate
  via DNS-01 against the real `monitor.mehrs.net` domain (already in
  Route 53) is the smaller, scoped fix - swap the self-signed cert, flip
  `OriginProtocolPolicy` to `https-only`, add a renewal job.
- Decision: deliberately deferred to before the 2027 Results Day cycle,
  not dropped. Current compensating controls (CloudFront-IP-only security
  group on port 80, the shared `X-Origin-Verify` secret) remain the
  interim mitigation - added to the prioritised recommendations list
  (#10) with the target timing, so it doesn't only exist in chat history.

## 2026-07-30 (6)

### Fixed - Grafana patching was failing silently, added SNS notification on failure
- User asked to confirm the Grafana instance is genuinely patched daily.
  Checked live (`aws ssm describe-maintenance-window-executions`) rather
  than assuming the stack existing meant it was working: the daily patch
  run had actually **failed 4 days running** (26-29 Jul 2026), with zero
  alerting - every other operational surface in this project has an alarm,
  this one didn't. Root cause: `"The instance IDs list contains an invalid
  entry"` - the Grafana EC2 instance was stopped at the scheduled 07:00 UTC
  patch time on each of those days (for unrelated admin work the night
  before, confirmed via CloudTrail `StopInstances`/`StartInstances`
  events), and SSM cannot patch a stopped instance. It succeeded on 30 Jul
  only because the instance happened to be running at 07:00 that day.
- First attempted fix was wrong and caught before deploying: tried to add
  CloudWatch alarms on `AWS/SSM` `MaintenanceWindowExecutionsFailed`/
  `Succeeded` metrics. Checked `aws cloudwatch list-metrics --namespace
  AWS/SSM` first and found this account publishes none - SSM Maintenance
  Windows don't emit CloudWatch metrics at all; they notify via SNS
  (`NotificationConfig` on the task) or EventBridge. Removed the invented
  alarms before they were ever deployed.
- Correct fix: added `NotificationConfig` (`Failed`, `TimedOut`,
  `Cancelled` events) to `PatchTask` in `stacks/patching.yaml`, pointed at
  the same `AlertsTopic` SNS topic every other alarm in this project
  already uses (imported via `ObservabilityStackName`, new parameter).
  Two things only found by actually attempting the deploy, not from
  documentation alone: (1) the SendCommand API requires its own
  `ServiceRoleArn` inside `MaintenanceWindowRunCommandParameters` whenever
  `NotificationConfig` is set, separate from the task-level
  `ServiceRoleArn` - the first deploy attempt failed with exactly this
  error, fixed by adding it; (2) `AmazonSSMMaintenanceWindowRole` (the
  managed policy already attached to the service role) does not include
  `sns:Publish` - checked the actual policy document via `aws iam
  get-policy-version` before assuming it would work, and added a scoped
  inline policy granting `sns:Publish` on just the alerts topic ARN.
- Deployed live and verified end-to-end: `NotificationConfig` and the new
  `ServiceRoleArn` are present on the live task
  (`aws ssm get-maintenance-window-task`), and the inline IAM policy
  granting `sns:Publish` is attached to the service role
  (`aws iam get-role-policy`) - not just "the deploy succeeded", the
  actual resulting configuration was read back and confirmed.
- Root behavioural cause (the instance being stopped at patch time) is not
  itself fixed by this change - this makes a future recurrence loud
  instead of silent, it doesn't prevent the instance being stopped again.
  If patching needs to be guaranteed rather than just alerted-on, that's a
  separate decision about whether the instance should ever be stopped
  outside a deliberate maintenance action.
