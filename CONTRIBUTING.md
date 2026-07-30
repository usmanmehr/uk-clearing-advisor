# Contributing to UK Clearing Advisor

Thanks for your interest in improving this project. Contributions of all sizes
are welcome - bug fixes, new data sources, documentation, and features.

## Ground rules
- Keep it serverless and low-cost; the app tier has no servers by design.
- Do not commit secrets, account IDs, real IPs, or personal data. Account
  specifics are placeholders (`REPLACE_*`) - keep them that way.
- Follow the existing style: plain British English in copy, no emojis, hyphens
  not em dashes.

## Guardrail: secrets and personal data
`scripts/check_sensitive_content.py` scans for AWS key patterns, private key
headers, weak placeholder secrets, and hardcoded account IDs in ARNs. CI runs
it on every push/PR (`sensitive-content-check` job) and blocks the build if it
finds a match in the added lines - this is enforced regardless of local setup.

To also catch this before you commit, install the local hook once per clone:
```bash
git config core.hooksPath scripts/hooks
```
If you have personal values specific to your own fork/account you want
checked locally too (a real name, your AWS account ID, a personal file path),
copy `.guardrails/local-denylist.txt.example` to
`.guardrails/local-denylist.txt` (git-ignored - it stays local, on purpose)
and add one string per line.

## Getting started
1. Read `ARCHITECTURE.md` - it maps every component to its CloudFormation stack
   and includes a "where to change what" guide.
2. Prerequisites: an AWS account, the AWS CLI, and Python 3. No Node/npm is
   needed - Lambdas use only the AWS SDK bundled in the Node.js 22 runtime.
3. Deploy into your own account following the steps in `README.md`.

## Making changes
- Lambda code lives in `lambda/`. After editing, run `scripts/build_lambdas.py`,
  upload the new zip, and (for SearchCourses) publish a new version and repoint
  the `live` alias - see `ARCHITECTURE.md`. Editing `$LATEST` alone will not
  reach production because the API invokes the alias.
- Infrastructure lives in `stacks/`. Validate with `cfn-lint stacks/*.yaml`
  before opening a PR (CI runs this automatically).
- Frontend is vanilla HTML/CSS/JS in `frontend/` - no build step.

## Pull requests
- Keep PRs focused and describe what you changed and how you tested it.
- Ensure `cfn-lint` passes (the "Validate CloudFormation" check).
- Update `README.md` / `ARCHITECTURE.md` if you change behaviour or structure.

## Data accuracy
This project must not present unverified data as fact. Search results are
flagged as estimated until a live UCAS feed is configured, and status badges are
university-level. If you add data, cite the source and keep the labelling
honest.

## Reporting issues
Use the issue templates for bugs and feature requests. For anything
security-sensitive, do not open a public issue - contact the maintainer directly.
