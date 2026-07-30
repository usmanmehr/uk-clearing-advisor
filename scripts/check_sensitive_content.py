#!/usr/bin/env python3
"""
Guardrail: blocks commits/PRs that introduce secrets, personal information,
or other content that shouldn't be in this public repo (per CONTRIBUTING.md:
"Do not commit secrets, account IDs, real IPs, or personal data").

Zero dependencies (stdlib only), matching this project's existing
no-npm/no-extra-deps convention (see lambda/shared/*.test.mjs, deploy.sh).

Two layers of checks:
1. Built-in structural patterns (safe to commit - they're regexes, not
   literal secrets): AWS access key IDs, private key headers, a weak
   static placeholder secret pattern, etc. These catch real, sensitive
   values wherever they appear. This file itself is excluded from
   scanning (see EXCLUDED_PATHS) since it necessarily contains the
   literal pattern text it's built to detect.
2. An optional LOCAL, git-ignored denylist (.guardrails/local-denylist.txt)
   for exact strings specific to one person/account - a real name, a real
   AWS account ID, a personal script path. This file is never committed
   (see .gitignore) precisely so the values it protects are never written
   into the repo in the first place, including by this checker itself.
   See .guardrails/local-denylist.txt.example for the format.

Usage:
  python3 scripts/check_sensitive_content.py                  # check staged changes (pre-commit)
  python3 scripts/check_sensitive_content.py --diff-against ORIGIN_SHA  # check a diff range (CI)
  python3 scripts/check_sensitive_content.py --all             # check every tracked file (manual audit)

Exit code 0 = clean, 1 = blocked (matches on found), 2 = usage/setup error.
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path
from typing import List, Tuple

REPO_ROOT = Path(__file__).resolve().parent.parent
LOCAL_DENYLIST_PATH = REPO_ROOT / ".guardrails" / "local-denylist.txt"

# This checker's own source necessarily contains the pattern literals it's
# built to detect - a pattern has to be defined somewhere. That's the tool
# definition, not a leak. Excluded from scanning to avoid a permanent
# self-inflicted false positive. Found by actually running this in CI
# against its own introducing PR, not assumed in advance.
EXCLUDED_PATHS = {
    "scripts/check_sensitive_content.py",
}

# Structural patterns - safe to keep in this committed script since none of
# these values are literal secrets, they're shapes that real secrets take.
BUILTIN_PATTERNS = [
    (r"\bAKIA[0-9A-Z]{16}\b", "AWS access key ID"),
    (r"\bASIA[0-9A-Z]{16}\b", "AWS temporary access key ID"),
    (r"-----BEGIN (RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----", "private key header"),
    (r"\bchange-me\b", "weak placeholder secret value (use no default instead)"),
    # A bare 12-digit number next to an ARN-like prefix is almost always a
    # real AWS account ID accidentally left in, not a REPLACE_* placeholder.
    (r"arn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:\d{12}:", "hardcoded AWS account ID in an ARN"),
]


def load_local_denylist() -> List[Tuple[str, str]]:
    """Load the optional local, git-ignored denylist. Returns [] if absent -
    this file existing at all is opt-in and personal to whoever set it up."""
    if not LOCAL_DENYLIST_PATH.exists():
        return []
    patterns = []
    for line in LOCAL_DENYLIST_PATH.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        patterns.append((re.escape(line), "local denylist entry"))
    return patterns


def get_staged_diff() -> str:
    result = subprocess.run(
        ["git", "diff", "--cached", "-U0"],
        cwd=REPO_ROOT, capture_output=True, text=True, check=True,
    )
    return result.stdout


def get_range_diff(base_ref: str) -> str:
    result = subprocess.run(
        ["git", "diff", "-U0", f"{base_ref}...HEAD"],
        cwd=REPO_ROOT, capture_output=True, text=True, check=True,
    )
    return result.stdout


def get_all_tracked_content() -> str:
    files = subprocess.run(
        ["git", "ls-files"], cwd=REPO_ROOT, capture_output=True, text=True, check=True,
    ).stdout.splitlines()
    chunks = []
    for f in files:
        if f in EXCLUDED_PATHS:
            continue
        path = REPO_ROOT / f
        if path.is_file():
            try:
                chunks.append(f"+++ {f}\n" + path.read_text(errors="ignore"))
            except Exception:
                pass
    return "\n".join(chunks)


def only_added_lines(diff_text: str) -> str:
    """Diff text includes removed lines too (prefixed '-') - only newly
    added content ('+') is what's about to land in the repo, so that's what
    we scan. Avoids flagging a commit that only *removes* a bad string.
    Also drops any hunk belonging to an excluded path (see EXCLUDED_PATHS)."""
    kept_lines = []
    skip_current_file = False
    for line in diff_text.splitlines():
        if line.startswith("+++ "):
            file_path = line[4:].lstrip("b/").strip()
            skip_current_file = file_path in EXCLUDED_PATHS
            continue
        if skip_current_file:
            continue
        if line.startswith("+") and not line.startswith("+++"):
            kept_lines.append(line)
    return "\n".join(kept_lines)


def scan(text: str, patterns: List[Tuple[str, str]]) -> List[str]:
    findings = []
    for pattern, description in patterns:
        for match in re.finditer(pattern, text):
            snippet = match.group(0)
            # Don't echo the actual secret value back in output for the
            # structural patterns - just confirm a match and its type.
            findings.append(f"  - {description}: matched pattern near '{snippet[:6]}...'")
    return findings


def main():
    args = sys.argv[1:]
    patterns = BUILTIN_PATTERNS + load_local_denylist()

    if "--all" in args:
        text = get_all_tracked_content()
    elif "--diff-against" in args:
        idx = args.index("--diff-against")
        if idx + 1 >= len(args):
            print("ERROR: --diff-against requires a ref argument", file=sys.stderr)
            return 2
        text = only_added_lines(get_range_diff(args[idx + 1]))
    else:
        text = only_added_lines(get_staged_diff())

    findings = scan(text, patterns)
    if findings:
        print("BLOCKED: sensitive content detected in this change:\n", file=sys.stderr)
        for f in findings:
            print(f, file=sys.stderr)
        print(
            "\nIf this is a false positive, review scripts/check_sensitive_content.py "
            "and adjust the pattern, or remove the flagged content before committing.",
            file=sys.stderr,
        )
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
