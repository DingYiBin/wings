#!/usr/bin/env bash
# Initialise or update wings reference repositories.
# Reads reference.txt, clones missing repos, updates existing ones.
# Lines starting with #no-update are cloned but never auto-updated.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
REFERENCE_DIR="$PROJECT_DIR/reference"

mkdir -p "$REFERENCE_DIR"

while IFS= read -r line; do
    # Skip empty lines and comments (but not #no-update)
    [[ -z "$line" ]] && continue
    [[ "$line" == \#* && "$line" != "#no-update"* ]] && continue

    no_update=0
    if [[ "$line" == "#no-update"* ]]; then
        no_update=1
        line="${line#\#no-update }"
    fi

    read -r name url <<< "$line"
    [[ -z "$name" || -z "$url" ]] && continue

    target="$REFERENCE_DIR/$name"

    if [[ -d "$target/.git" ]]; then
        if [[ $no_update -eq 1 ]]; then
            echo "[skip]   $name (no-update)"
        else
            echo "[update] $name"
            git -C "$target" pull --ff-only
        fi
    else
        echo "[clone]  $name <- $url"
        git clone --depth 1 "$url" "$target"
    fi
done < "$PROJECT_DIR/reference.txt"

echo "Done."
