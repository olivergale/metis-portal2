#!/bin/bash
# Entrypoint script for Sprite Fly Machine
# Starts HTTP health endpoint on port 8080 with explicit 200 status on /health

set -e

# Start mutation watcher in background
echo "Starting mutation watcher..."
/usr/local/bin/mutation-watcher.sh &
MUTATION_PID=$!

echo "Mutation watcher started with PID: $MUTATION_PID"

# Start HTTP health endpoint with proper /health route
echo "Starting health endpoint on port 8080..."

# Use Node.js for explicit health endpoint returning 200 status
node -e "
const http = require('http');
const PORT = 8080;

const server = http.createServer((req, res) => {
  // Health endpoint - returns 200 status
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    return;
  }
  // 404 for other routes
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log('Health endpoint listening on port ' + PORT);
});
" &
HTTP_PID=$!

echo "Health endpoint started with PID: $HTTP_PID"

# Keep container running
cleanup() {
    echo "Shutting down..."
    kill $MUTATION_PID 2>/dev/null || true
    kill $HTTP_PID 2>/dev/null || true
}

trap cleanup SIGTERM SIGINT

# Wait forever
wait
