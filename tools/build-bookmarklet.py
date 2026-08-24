#!/usr/bin/env python3
"""Rebuild bookmark.js from exportConversation.js.

The bookmarklet is the whole script wrapped in an IIFE and percent-encoded into a
javascript: URL. The IIFE matters: a bookmark gets clicked repeatedly, and the
top-level `const` declarations would collide on the second run without it.

Run from the repo root:  python3 tools/build-bookmarklet.py
"""
import pathlib
import re
import subprocess
import sys
import tempfile
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "exportConversation.js"
TARGET = ROOT / "bookmark.js"

EXPORTS = [
    "exportConversation", "downloadConversation",
    "showExportMenu", "closeExportMenu", "mwsToCsv",
]


def strip(source: str) -> str:
    """Drop whole-line comments and leading tabs.

    Deliberately not a minifier: no regex is run over the code itself, so string
    and regex literals cannot be corrupted. The only multi-line template literal
    is the menu's CSS, where indentation is insignificant -- asserted below.
    """
    literals = [t for t in re.findall(r"`[^`]*`", source, re.S) if "\n" in t]
    assert len(literals) == 1 and "{" in literals[0], (
        f"expected exactly one multi-line template literal (the CSS), found "
        f"{len(literals)}; stripping indentation could change a string's value"
    )

    kept = [
        line.lstrip("\t")
        for line in source.split("\n")
        if not line.strip().startswith("//")
    ]
    return "\n".join(line for line in kept if line.strip())


def check(code: str, label: str) -> None:
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as handle:
        handle.write(code)
        path = handle.name
    result = subprocess.run(["node", "--check", path], capture_output=True, text=True)
    pathlib.Path(path).unlink()
    if result.returncode:
        sys.exit(f"{label} failed to parse:\n{result.stderr}")


def main() -> None:
    payload = (
        "(function(){" + strip(SOURCE.read_text(encoding="utf-8")) + "\n;"
        + "".join(f"window.{name}={name};" for name in EXPORTS)
        + "})();void 0;"
    )
    check(payload, "payload")

    # Encode only what a javascript: URL actually reserves. Full percent-encoding
    # would inflate this by ~50% for no benefit.
    url = "javascript:" + (
        payload.replace("%", "%25").replace("#", "%23").replace("\n", "%0A").replace("\r", "")
    )

    decoded = urllib.parse.unquote(url[len("javascript:"):])
    assert decoded == payload, "URL does not decode back to the payload"
    check(decoded, "decoded URL")

    TARGET.write_text(url, encoding="utf-8")
    print(f"wrote {TARGET.name}: {len(url):,} chars, {url.count(chr(10))} newlines")


if __name__ == "__main__":
    main()
