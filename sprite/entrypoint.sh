#!/bin/bash
# Sprite Entrypoint — Bootstrap agent execution environment
# Lifecycle: start watcher → clone repo → start health server → wait for /run signal

set -e

echo "[sprite] Starting at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
export SPRITE_STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Ensure workspace dirs exist (volume mount overwrites Dockerfile dirs)
mkdir -p /workspace/.mutations /var/log/sprite

# Write initial status
echo "idle" > /workspace/.sprite-status

# 1. Start mutation watcher in background
echo "[sprite] Starting mutation watcher..."
/app/mutation-watcher.sh /workspace &
WATCHER_PID=$!
echo "[sprite] Mutation watcher PID: $WATCHER_PID"

# 2. Clone/update repo if GITHUB_TOKEN is set
if [ -n "$GITHUB_TOKEN" ]; then
  REPO_DIR="/workspace/repo"
  REPO_URL="https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO:-olivergale/metis-portal2}.git"

  if [ -d "$REPO_DIR/.git" ]; then
    echo "[sprite] Pulling latest from repo..."
    cd "$REPO_DIR" && git pull --ff-only 2>/dev/null || true
    cd /app
  else
    echo "[sprite] Cloning repo..."
    git clone --depth 1 "$REPO_URL" "$REPO_DIR" 2>/dev/null
  fi

  # Create worktree for WO if slug provided
  if [ -n "$WO_SLUG" ] && [ -d "$REPO_DIR/.git" ]; then
    WORK_DIR="/workspace/$WO_SLUG"
    if [ ! -d "$WORK_DIR" ]; then
      echo "[sprite] Creating worktree for $WO_SLUG..."
      cd "$REPO_DIR"
      git worktree add --detach "$WORK_DIR" 2>/dev/null || cp -r "$REPO_DIR" "$WORK_DIR"
      cd /app
    fi
    export SPRITE_WORK_DIR="$WORK_DIR"
    echo "[sprite] Working directory: $WORK_DIR"
  fi
else
  echo "[sprite] No GITHUB_TOKEN — skipping repo clone"
fi

# 3. Start health server (also serves /run, /mutations, /evidence endpoints)
echo "[sprite] Starting health server on port ${PORT:-8080}..."
deno run --allow-net --allow-read --allow-write=/workspace --allow-env \
  /app/health-server.ts &
HEALTH_PID=$!

# 4. If SPRITE_MODE=agent and WO context is provided, start immediately
if [ "$SPRITE_MODE" = "agent" ] && [ -n "$WO_ID" ]; then
  echo "[sprite] Auto-starting agent loop for WO $WO_SLUG..."
  echo "running" > /workspace/.sprite-status

  # The agent runner is a Deno script that imports agent-loop.ts
  # and runs the tool-use loop with direct filesystem access
  if [ -f "/app/sprite-agent.ts" ]; then
    deno run --allow-all /app/sprite-agent.ts 2>&1 | tee /var/log/sprite/agent.log
    EXIT_CODE=$?

    if [ $EXIT_CODE -eq 0 ]; then
      echo "completed" > /workspace/.sprite-status
    else
      echo "failed" > /workspace/.sprite-status
    fi
  else
    echo "[sprite] No sprite-agent.ts found — waiting for /run signal"
  fi
fi

# 5. Keep alive — wait for health server or signals
echo "[sprite] Ready. Health server running, waiting for commands..."
wait $HEALTH_PID
