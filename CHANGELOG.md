# Changelog

All notable changes to UK Clearing Advisor are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## 2026-07-23

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
