#!/usr/bin/env bash
# Initialise or update wings reference repositories.
# Reads reference.txt, clones missing repos, updates existing ones.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
REFERENCE_DIR="$PROJECT_DIR/reference"

mkdir -p "$REFERENCE_DIR"

while read -r name url; do
    # Skip empty lines and comments
    [[ -z "$name" || "$name" == \#* ]] && continue

    target="$REFERENCE_DIR/$name"

    if [[ -d "$target/.git" ]]; then
        echo "[update] $name"
        git -C "$target" pull --ff-only
    else
        echo "[clone] $name <- $url"
        git clone --depth 1 "$url" "$target"
    fi
done < "$PROJECT_DIR/reference.txt"

echo "Done."
