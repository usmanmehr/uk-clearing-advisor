# Changelog

All notable changes to UK Clearing Advisor are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## 2026-07-23

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
