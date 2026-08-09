#!/usr/bin/env python3
"""Build the frontend for deploy.

Content-hashes app.js and styles.css so that every new version is a
brand-new URL the browser has never seen - this is what forces a fresh
download automatically instead of a visitor's browser (or CloudFront's
edge cache) silently keeping a stale copy after a deploy. Every HTML
file's <script src>/<link href> is rewritten to point at the hashed
filename.

frontend/ (the checked-in source) is never modified - it always keeps the
plain, easy-to-read /app.js and /styles.css references. This script only
generates build/frontend/ (git-ignored), which is what deploy.sh uploads
to S3. Re-running it recomputes the hash from current content, so the
hashed filename only changes when the file's content actually changes.

Usage: python3 scripts/build_frontend.py
"""
import hashlib
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "frontend"
DST = ROOT / "build" / "frontend"

# Files that get a content-hash appended to their name. This is what lets
# deploy.sh cache them forever at both CloudFront and the browser (see
# HASHED_CACHE_CONTROL in deploy.sh) without ever risking a stale copy -
# the filename itself changes the moment the content does.
HASHED_FILES = ["app.js", "styles.css"]

HASH_LENGTH = 10  # hex chars - short but effectively collision-safe here.


def content_hash(path: Path) -> str:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return digest[:HASH_LENGTH]


def main() -> None:
    if DST.exists():
        shutil.rmtree(DST)
    DST.mkdir(parents=True)

    # 1. Hash the versioned files and copy them under their new name.
    renames = {}
    for name in HASHED_FILES:
        src_file = SRC / name
        if not src_file.exists():
            print(f"WARNING: {src_file} not found, skipping", file=sys.stderr)
            continue
        stem, ext = name.rsplit(".", 1)
        hashed_name = f"{stem}.{content_hash(src_file)}.{ext}"
        shutil.copy2(src_file, DST / hashed_name)
        renames[f"/{name}"] = f"/{hashed_name}"
        print(f"  {name} -> {hashed_name}")

    # 2. Copy every other file as-is, rewriting references to the hashed
    #    files in any HTML along the way.
    for src_file in SRC.rglob("*"):
        if not src_file.is_file():
            continue
        if src_file.name in HASHED_FILES:
            continue  # already handled above, under its hashed name
        rel = src_file.relative_to(SRC)
        dst_file = DST / rel
        dst_file.parent.mkdir(parents=True, exist_ok=True)
        if src_file.suffix == ".html":
            text = src_file.read_text(encoding="utf-8")
            for old, new in renames.items():
                text = text.replace(f'"{old}"', f'"{new}"')
            dst_file.write_text(text, encoding="utf-8")
        else:
            shutil.copy2(src_file, dst_file)

    print(f"Built {DST}")


if __name__ == "__main__":
    main()
