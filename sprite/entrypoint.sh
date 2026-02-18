#!/bin/bash
# Entrypoint script for Sprite Fly Machine
# Starts HTTP health endpoint on port 8080

set -e

# Start mutation watcher in background
echo "Starting mutation watcher..."
/usr/local/bin/mutation-watcher.sh &
MUTATION_PID=$!

echo "Mutation watcher started with PID: $MUTATION_PID"

# Start HTTP health endpoint
echo "Starting health endpoint on port 8080..."

# Simple HTTP server using Python
python3 -m http.server 8080 &
HTTP_PID=$!

echo "HTTP server started with PID: $HTTP_PID"

# Keep container running and respond to health checks
cleanup() {
    echo "Shutting down..."
    kill $MUTATION_PID 2>/dev/null || true
    kill $HTTP_PID 2>/dev/null || true
}

trap cleanup SIGTERM SIGINT

# Wait forever (or respond to health checks)
while true; do
    # Check if processes are still running
    if ! kill -0 $HTTP_PID 2>/dev/null; then
        echo "HTTP server died, restarting..."
        python3 -m http.server 8080 &
        HTTP_PID=$!
    fi
    sleep 5
done
