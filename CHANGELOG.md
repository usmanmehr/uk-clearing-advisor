# Changelog

All notable changes to UK Clearing Advisor are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

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
  A\*AA=152). Scoped to A-levels only per instruction; other qualification
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
- Found while directly answering "is this fit for purpose": the search
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
- Noted but out of scope by request: a real, active AWS access key was
  found in plaintext in the operator's local `~/.aws/credentials`,
  `.bak`, and `.bash_history` - confirmed NOT present anywhere in the git
  repository or its history. Workstation-local risk, not an application
  vulnerability; no changes made to the workstation per instruction.

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
