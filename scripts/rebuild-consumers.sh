#!/usr/bin/env bash
#
# Rebuild the consumer bundles after a change to @dbt-open-lineage/core.
#
# core is consumed as SOURCE (no build of its own), so its edits only reach
# users once the consumers' bundles are regenerated:
#   - mext   → packages/mext/dist/  (+ packages/mext/dbt-dag-viz.mext)
#   - vscode → packages/vscode/out/extension.js + packages/vscode/media/
#
# Usage:
#   scripts/rebuild-consumers.sh [--mext-only|--vscode-only] [--no-pack]
#     --mext-only     rebuild only the .mext consumer
#     --vscode-only   rebuild only the VSCode extension
#     --no-pack       skip zipping the .mext bundle (build dist/ only)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MEXT=1; VSCODE=1; PACK=1
for a in "$@"; do
  case "$a" in
    --mext-only)    VSCODE=0 ;;
    --vscode-only)  MEXT=0 ;;
    --no-pack)      PACK=0 ;;
    -h|--help)      sed -n '/^# Rebuild/,/^#   *--no-pack/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown arg: $a (try --help)" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1;36m▸ %s\033[0m\n' "$1"; }
fail() { printf '\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# Guard: core is consumed as source — a type error would silently bundle a
# broken UI. Catch it before spending time on the consumer builds.
say "core typecheck"
npm run typecheck -w packages/core

if [ "$MEXT" = 1 ]; then
  say "mext build  →  packages/mext/dist/"
  npm run build -w packages/mext
  [ -f packages/mext/dist/index.html ] || fail "mext build produced no dist/index.html"
  if [ "$PACK" = 1 ]; then
    say "mext pack   →  packages/mext/dbt-dag-viz.mext"
    npm run pack -w packages/mext
  fi
fi

if [ "$VSCODE" = 1 ]; then
  say "vscode build  →  out/extension.js + media/"
  npm run build -w packages/vscode
  [ -f packages/vscode/out/extension.js ]     || fail "vscode host build missing out/extension.js"
  ls packages/vscode/media/*.js >/dev/null 2>&1 || fail "vscode webview build produced no media/*.js (webview would render blank)"
fi

say "done — rebuilt artifacts:"
if [ "$MEXT" = 1 ]; then
  echo "  mext webview  : packages/mext/dist/"
  [ "$PACK" = 1 ] && echo "  mext bundle   : packages/mext/dbt-dag-viz.mext"
fi
if [ "$VSCODE" = 1 ]; then
  echo "  vscode host   : packages/vscode/out/extension.js"
  echo "  vscode webview: packages/vscode/media/"
fi
