#!/usr/bin/env python3
"""Stamp WAW's script/stylesheet URLs with a content hash (cache busting).

GitHub Pages lets browsers reuse files for 10 minutes, so after an update a
browser could combine new JavaScript with old CSS (or the reverse). Every local
asset URL gets `?v=<hash of the file>`: the URL only changes when the file
changes, so a page always loads one consistent set of files.

Run from the repository root (the GitHub Action does this on every push):
    python tools/stamp_assets.py          # rewrite files
    python tools/stamp_assets.py --check  # exit 1 if anything is out of date
"""
import hashlib
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


def digest(rel):
    return hashlib.sha256((ROOT / rel).read_bytes()).hexdigest()[:10]


def stamp(text, pattern, rel_of):
    """replace every matched URL with url?v=<hash>; returns the new text"""
    def repl(m):
        rel = rel_of(m)
        if not (ROOT / rel).is_file():
            return m.group(0)
        return f'{m.group("pre")}{rel}?v={digest(rel)}{m.group("post")}'
    return re.sub(pattern, repl, text)


def main():
    check = "--check" in sys.argv
    changed = []

    # 1) the AudioWorklet module is loaded from js/fx.js
    fx = ROOT / "js/fx.js"
    old = fx.read_text(encoding="utf-8")
    new = stamp(old, r'(?P<pre>addModule\(")(?P<url>js/worklets\.js)(\?v=[0-9a-f]*)?(?P<post>")', lambda m: m.group("url"))
    if new != old:
        changed.append("js/fx.js")
        if not check:
            fx.write_text(new, encoding="utf-8", newline="\n")

    # 2) index.html: local <script src> and <link href> (after fx.js got its new hash)
    idx = ROOT / "index.html"
    old = idx.read_text(encoding="utf-8")
    pattern = r'(?P<pre>(?:src|href)=")(?P<url>(?!https?:|data:|//)[^"?#]+\.(?:js|css))(\?v=[0-9a-f]*)?(?P<post>")'
    new = stamp(old, pattern, lambda m: m.group("url"))
    if new != old:
        changed.append("index.html")
        if not check:
            idx.write_text(new, encoding="utf-8", newline="\n")

    if changed:
        print(("out of date: " if check else "stamped: ") + ", ".join(changed))
        return 1 if check else 0
    print("asset versions up to date")
    return 0


if __name__ == "__main__":
    sys.exit(main())
