#!/bin/bash
# Mutation Watcher — Filesystem-level mutation capture for Sprites
# Uses inotifywait to watch /workspace recursively
# Outputs JSONL to /workspace/.mutations/fs-events.jsonl

WATCH_DIR="${1:-/workspace}"
OUTPUT_FILE="/workspace/.mutations.jsonl"
EXCLUDE_PATTERN="(\.git/|\.mutations/|node_modules/|__pycache__/)"

echo "[mutation-watcher] Starting filesystem watch on $WATCH_DIR"
echo "[mutation-watcher] Output: $OUTPUT_FILE"

# Create output file if it doesn't exist
touch "$OUTPUT_FILE"

# Watch for file events recursively
# Events: create, modify, delete, moved_from, moved_to
inotifywait -m -r \
  --format '{"timestamp":"%T","event_type":"%e","path":"%w%f"}' \
  --timefmt '%Y-%m-%dT%H:%M:%S' \
  --exclude "$EXCLUDE_PATTERN" \
  -e create -e modify -e delete -e moved_from -e moved_to \
  "$WATCH_DIR" 2>/dev/null | while IFS= read -r line; do
    # Extract path using jq (no python dependency)
    filepath=$(echo "$line" | jq -r '.path' 2>/dev/null)
    if [ -f "$filepath" ] 2>/dev/null; then
      size=$(stat -c %s "$filepath" 2>/dev/null || echo "0")
    else
      size="0"
    fi

    # Add size_bytes and wo_slug using jq
    enriched=$(echo "$line" | jq -c \
      --argjson sz "$size" \
      --arg slug "${WO_SLUG:-unknown}" \
      '. + {size_bytes: $sz, wo_slug: $slug}' 2>/dev/null)

    if [ -n "$enriched" ]; then
      echo "$enriched" >> "$OUTPUT_FILE"
    else
      echo "$line" >> "$OUTPUT_FILE"
    fi
done
