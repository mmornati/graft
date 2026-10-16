"""MkDocs hooks for the Graft documentation site (mkdocs.yml: hooks).

The Markdown in docs/ is written to be read on GitHub, so a few links point outside docs/ (the README, SECURITY.md,
source files) or at a folder (docs/pilots/, the review notes). MkDocs cannot serve those, and in strict mode it fails
on them. This hook rewrites exactly those relative links to the same path on GitHub; every link between pages stays a
normal MkDocs link and is still checked.
"""

from __future__ import annotations

import os
import re

REPO = "https://github.com/mmornati/graft"
BRANCH = "main"

# [text](target) or [text](target "title"); skips images' own syntax only by sharing it, which is fine here.
LINK = re.compile(r"(\]\()([^)\s#]+)(#[^)\s]*)?((?:\s+\"[^\"]*\")?\))")
FENCE = re.compile(r"^(\s*)(```|~~~)")


def _rewrite(target: str, page_dir: str, docs_dir: str, repo_root: str) -> str | None:
    if re.match(r"^[a-z][a-z0-9+.-]*:", target, re.I) or target.startswith("/"):
        return None  # absolute URL or site-absolute path
    resolved = os.path.normpath(os.path.join(page_dir, target))
    inside = resolved == docs_dir or resolved.startswith(docs_dir + os.sep)
    if inside and not os.path.isdir(resolved):
        return None  # a page or a file MkDocs copies: leave it to MkDocs (and its link check)
    if inside and os.path.isdir(resolved) and (
        os.path.exists(os.path.join(resolved, "README.md")) or os.path.exists(os.path.join(resolved, "index.md"))
    ):
        return None  # a folder with an index page is a page
    rel = os.path.relpath(resolved, repo_root).replace(os.sep, "/")
    if rel.startswith(".."):
        return None
    kind = "tree" if os.path.isdir(resolved) else "blob"
    return f"{REPO}/{kind}/{BRANCH}/{rel}"


def on_page_markdown(markdown, page, config, files):
    docs_dir = os.path.normpath(config["docs_dir"])
    repo_root = os.path.dirname(docs_dir)
    page_dir = os.path.dirname(os.path.join(docs_dir, page.file.src_path))
    out, in_fence, fence_mark = [], False, ""
    for line in markdown.split("\n"):
        m = FENCE.match(line)
        if m:
            if not in_fence:
                in_fence, fence_mark = True, m.group(2)
            elif m.group(2) == fence_mark:
                in_fence = False
            out.append(line)
            continue
        if not in_fence:
            def sub(mm):
                new = _rewrite(mm.group(2), page_dir, docs_dir, repo_root)
                if new is None:
                    return mm.group(0)
                return mm.group(1) + new + (mm.group(3) or "") + mm.group(4)
            line = LINK.sub(sub, line)
        out.append(line)
    return "\n".join(out)
