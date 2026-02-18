#!/bin/bash
# Mutation watcher script
# Logs file create/modify/delete events to /workspace/.mutations.jsonl
# Format: timestamp, event_type, path, size_bytes

WATCH_DIR="/workspace"
LOG_FILE="/workspace/.mutations.jsonl"

echo "Mutation watcher started. Watching: $WATCH_DIR"
echo "Logging to: $LOG_FILE"

# Ensure log file exists
touch "$LOG_FILE"

# Function to log mutation event
log_mutation() {
    local event_type="$1"
    local file_path="$2"
    
    # Get file size (0 if deleted or doesn't exist)
    local size_bytes=0
    if [ -f "$file_path" ]; then
        size_bytes=$(stat -c%s "$file_path" 2>/dev/null || echo 0)
    fi
    
    # Get timestamp in ISO 8601 format
    local timestamp
    timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    
    # Write JSONL entry
    echo "{\"timestamp\": \"$timestamp\", \"event_type\": \"$event_type\", \"path\": \"$file_path\", \"size_bytes\": $size_bytes}" >> "$LOG_FILE"
    
    echo "Logged: $event_type $file_path ($size_bytes bytes)"
}

# Use inotifywait to watch for file changes
# -m: monitor mode (continuous)
# -r: recursive
# -e: events to watch
# --format: output format
inotifywait -m -r -e create -e modify -e delete -e move --format '%e %w%f' "$WATCH_DIR" 2>/dev/null | while read EVENT FILE_PATH; do
    # Skip the log file itself to avoid infinite loops
    if [[ "$FILE_PATH" == *".mutations.jsonl" ]]; then
        continue
    fi
    
    # Convert inotify event to our event type
    case "$EVENT" in
        CREATE)
            event_type="create";;
        MODIFY)
            event_type="modify";;
        DELETE)
            event_type="delete";;
        MOVED_FROM)
            event_type="delete";;
        MOVED_TO)
            event_type="create";;
        *)
            event_type="unknown";;
    esac
    
    log_mutation "$event_type" "$FILE_PATH"
done
