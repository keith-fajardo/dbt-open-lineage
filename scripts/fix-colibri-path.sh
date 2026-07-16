#!/usr/bin/env bash
# Fix "colibri generate failed: Usage: colibri generate [OPTIONS]" in VSCode CLL.
# Root cause: dbt-colibri installed only inside a venv; VSCode (launched from
# Finder/Dock) doesn't inherit that venv's PATH, so spawn("colibri", ...) finds
# a different (or no) colibri binary. Fix: symlink the venv's colibri into
# /usr/local/bin, which IS on the default PATH for GUI-launched apps on macOS.

set -euo pipefail

TARGET_DIR="/usr/local/bin"
TARGET_LINK="${TARGET_DIR}/colibri"

echo "Looking for colibri inside Python venvs..."

CANDIDATES=()
while IFS= read -r -d '' bin; do
  CANDIDATES+=("$bin")
done < <(find "$HOME" -maxdepth 6 -path '*/.venv/bin/colibri' -print0 2>/dev/null; \
          find "$HOME" -maxdepth 6 -path '*/venv/bin/colibri' -print0 2>/dev/null)

if [ "${1:-}" != "" ]; then
  # Explicit path passed by user, e.g. ./fix-colibri-path.sh ~/Developer/dbt/.venv/bin/colibri
  CANDIDATES=("$1")
fi

if [ ${#CANDIDATES[@]} -eq 0 ]; then
  echo "No venv colibri found under \$HOME (searched .venv/bin, venv/bin, depth 6)."
  echo "Run manually: $0 /path/to/your/venv/bin/colibri"
  exit 1
fi

if [ ${#CANDIDATES[@]} -gt 1 ]; then
  echo "Found multiple candidates:"
  for i in "${!CANDIDATES[@]}"; do
    echo "  [$i] ${CANDIDATES[$i]}"
  done
  read -rp "Pick index to use: " idx
  COLIBRI_BIN="${CANDIDATES[$idx]}"
else
  COLIBRI_BIN="${CANDIDATES[0]}"
fi

if [ ! -x "$COLIBRI_BIN" ]; then
  echo "Not executable: $COLIBRI_BIN"
  exit 1
fi

echo "Using: $COLIBRI_BIN"
"$COLIBRI_BIN" --version || true

if [ ! -d "$TARGET_DIR" ]; then
  echo "Creating $TARGET_DIR (needs sudo)..."
  sudo mkdir -p "$TARGET_DIR"
fi

if [ -e "$TARGET_LINK" ] || [ -L "$TARGET_LINK" ]; then
  echo "Existing $TARGET_LINK found:"
  ls -la "$TARGET_LINK"
  read -rp "Overwrite with symlink to venv colibri? [y/N] " confirm
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "Aborted, nothing changed."
    exit 1
  fi
  sudo rm -f "$TARGET_LINK"
fi

sudo ln -s "$COLIBRI_BIN" "$TARGET_LINK"
echo "Linked $TARGET_LINK -> $COLIBRI_BIN"

echo
echo "Verifying (this is what VSCode's spawn(\"colibri\", ...) will now find):"
/usr/bin/env -i /usr/bin/which colibri 2>/dev/null || echo "colibri" | xargs -I{} which {}
"$TARGET_LINK" --version

echo
echo "Done. Restart VSCode (or reload window: Cmd+Shift+P > Reload Window) and retry Columns/CLL."
