#!/usr/bin/env bash
# Build the public site into ./site: the landing page (website/) at the root, the MkDocs documentation (docs/) under
# /docs/. Every example on the site is fictional (the acme organisation from the README).
#   pip install -r requirements-docs.txt && bash scripts/build-site.sh       # then: python3 -m http.server -d site 8000
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
rm -rf site
mkdocs build --strict -d site/docs
cp -R website/. site/
# sanity checks: the landing page, its assets and the docs home exist; the landing links only to pages that were built
for f in index.html css/site.css js/site.js assets/mark.svg assets/favicon.svg docs/index.html docs/404.html; do
  test -f "site/$f" || { echo "missing site/$f" >&2; exit 1; }
done
for href in $(grep -oE 'href="docs/[^"#]*' website/index.html | sed 's/^href="//' | sort -u); do
  test -f "site/${href%/}/index.html" || test -f "site/$href" || { echo "landing links to $href, which was not built" >&2; exit 1; }
done
echo "site/ ready: $(du -sh site | cut -f1)"
