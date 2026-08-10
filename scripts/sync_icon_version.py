#!/usr/bin/env python3
"""Stamps manifest.json's icon src URLs with a content-hash query string
whenever icon-192.png/icon-512.png change.

Run automatically by the pre-commit hook (.githooks/pre-commit). Safe to run
manually too -- it's a no-op if the icon files haven't changed.

Android/Chrome's installed-PWA (WebAPK) icon-update check only re-fetches an
icon when its URL in the manifest changes -- it diffs the icons array, not
pixel bytes -- so overwriting icon-192.png/icon-512.png in place would never
be noticed by an existing install, or even by a fresh "Add to Home Screen"
after an Android uninstall (which doesn't clear Chrome's site data for the
origin). Appending a content hash to the src query string gives every icon
change a new URL, which is what actually triggers Chrome to pick it up.
"""
import hashlib
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST_PATH = ROOT / "manifest.json"
INDEX_PATH = ROOT / "index.html"


def digest_for(rel_path):
    file_path = ROOT / rel_path
    if not file_path.is_file():
        sys.exit(f"missing icon referenced by manifest/index.html: {rel_path}")
    return hashlib.sha256(file_path.read_bytes()).hexdigest()[:8]


def main():
    changed_paths = []

    manifest_text = MANIFEST_PATH.read_text(encoding="utf-8")

    def replace_manifest_src(m):
        rel_path = m.group(1)
        return f'"src": "{rel_path}?v={digest_for(rel_path)}"'

    new_manifest_text = re.sub(
        r'"src":\s*"(icon-(?:192|512)\.png)(?:\?v=[0-9a-f]+)?"',
        replace_manifest_src,
        manifest_text,
    )
    if new_manifest_text != manifest_text:
        MANIFEST_PATH.write_text(new_manifest_text, encoding="utf-8")
        changed_paths.append(MANIFEST_PATH)

    # index.html's apple-touch-icon isn't read from manifest.json by iOS
    # Safari, so it needs the same content-hash stamp kept in sync
    # separately -- otherwise a changed icon updates Android's install but
    # leaves iOS's Home Screen icon stale. See sw.js's top-of-file comment.
    index_text = INDEX_PATH.read_text(encoding="utf-8")

    def replace_apple_touch_icon(m):
        rel_path = m.group(1)
        return f'<link rel="apple-touch-icon" href="{rel_path}?v={digest_for(rel_path)}">'

    new_index_text = re.sub(
        r'<link rel="apple-touch-icon" href="(icon-192\.png)(?:\?v=[0-9a-f]+)?">',
        replace_apple_touch_icon,
        index_text,
    )
    if new_index_text != index_text:
        INDEX_PATH.write_text(new_index_text, encoding="utf-8")
        changed_paths.append(INDEX_PATH)

    if not changed_paths:
        print("manifest.json/index.html icon URLs already up to date")
        return

    subprocess.run(["git", "add", *[str(p) for p in changed_paths]], cwd=ROOT, check=True)
    print(f"icon URLs updated in: {', '.join(p.name for p in changed_paths)}")


if __name__ == "__main__":
    main()
