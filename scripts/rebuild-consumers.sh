#!/usr/bin/env bash
#
# Rebuild the consumer bundles after a change to @dbt-open-lineage/core.
#
# core is consumed as SOURCE (no build of its own), so its edits only reach
# users once the consumers' bundles are regenerated:
#   - mext   → packages/mext/dist/  (+ packages/mext/dbt-dag-viz.mext)
#   - vscode → packages/vscode/out/extension.js + packages/vscode/media/
#   - cli    → packages/cli/out/cli.js + packages/cli/dist/webview/
#
# Usage:
#   scripts/rebuild-consumers.sh [--mext-only|--vscode-only|--cli-only] [--no-pack]
#     --mext-only     rebuild only the .mext consumer
#     --vscode-only   rebuild only the VSCode extension
#     --cli-only      rebuild only the static-site CLI
#     --no-pack       skip zipping the .mext bundle (build dist/ only)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

MEXT=1; VSCODE=1; CLI=1; PACK=1
for a in "$@"; do
  case "$a" in
    --mext-only)    VSCODE=0; CLI=0 ;;
    --vscode-only)  MEXT=0; CLI=0 ;;
    --cli-only)     MEXT=0; VSCODE=0 ;;
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
  [ -f packages/vscode/out/extension.js ]        || fail "vscode host build missing out/extension.js"
  [ -f packages/vscode/media/index.html ]        || fail "vscode webview build missing media/index.html (webview would render blank)"
  ls packages/vscode/media/assets/*.js >/dev/null 2>&1 || fail "vscode webview build produced no media/assets/*.js (webview would render blank)"

  if [ "$PACK" = 1 ]; then
    VSVER=$(node -p "require('./packages/vscode/package.json').version")
    say "vscode pack   →  packages/vscode/dbt-open-lineage-$VSVER.vsix"
    # Clear stale .vsix from older versions — an install-from-disk otherwise
    # picks up whichever old file the user clicks (this bit us: 0.3.4 lingered).
    rm -f packages/vscode/dbt-open-lineage-*.vsix
    npm run package -w packages/vscode
    [ -f "packages/vscode/dbt-open-lineage-$VSVER.vsix" ] || fail "vscode package produced no dbt-open-lineage-$VSVER.vsix"
  fi
fi

if [ "$CLI" = 1 ]; then
  say "cli build  →  out/cli.js + dist/webview/"
  npm run build -w packages/cli
  [ -f packages/cli/out/cli.js ]                    || fail "cli build missing out/cli.js"
  [ -f packages/cli/dist/webview/assets/main.js ]   || fail "cli webview build missing dist/webview/assets/main.js"
fi

say "done — rebuilt artifacts:"
if [ "$MEXT" = 1 ]; then
  echo "  mext webview  : packages/mext/dist/"
  [ "$PACK" = 1 ] && echo "  mext bundle   : packages/mext/dbt-dag-viz.mext"
fi
if [ "$VSCODE" = 1 ]; then
  echo "  vscode host   : packages/vscode/out/extension.js"
  echo "  vscode webview: packages/vscode/media/"
  [ "$PACK" = 1 ] && echo "  vscode vsix    : packages/vscode/dbt-open-lineage-$(node -p "require('./packages/vscode/package.json').version").vsix"
fi
if [ "$CLI" = 1 ]; then
  echo "  cli bin       : packages/cli/out/cli.js"
  echo "  cli webview   : packages/cli/dist/webview/"
fi
