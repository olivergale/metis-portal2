#!/bin/bash
# OpenCode Runner — Executes a work order using OpenCode CLI
# Called by entrypoint.sh when SPRITE_MODE=opencode
# Uses OpenRouter models + Supabase MCP for database access

set -e

echo "[opencode-runner] Starting OpenCode execution for WO $WO_SLUG"

# Set up OpenCode config directory
# OpenCode looks for config in: ./.opencode.json, ~/.config/opencode/opencode.json, or $XDG_CONFIG_HOME/opencode/opencode.json
export XDG_CONFIG_HOME="/workspace/.config"
mkdir -p "$XDG_CONFIG_HOME/opencode"

# Copy OpenCode config to workspace
cp /app/opencode.json /workspace/opencode.json

# Generate AGENTS.md dynamically from Supabase tables
# Mirrors sprite-agent.ts buildSystemPrompt() — context is table-driven, not static
export AGENT_NAME="${AGENT_NAME:-builder}"
/app/generate-agents-md.sh /workspace/AGENTS.md

# SUPABASE_ACCESS_TOKEN is the PAT for the hosted Supabase MCP server
# It's injected as an env var by the sprite-dispatcher
# OpenCode reads it via {env:SUPABASE_ACCESS_TOKEN} in opencode.json

# Determine model (from env or default)
MODEL="${AGENT_MODEL:-openrouter/minimax/minimax-m2.5}"

# Ensure model has provider prefix for OpenCode
if [[ ! "$MODEL" == *"/"*"/"* ]]; then
  MODEL="openrouter/$MODEL"
fi

# Build the prompt from WO context
WO_PROMPT="You are executing work order ${WO_SLUG} (ID: ${WO_ID}).

## Objective
${WO_OBJECTIVE}

## Acceptance Criteria
${WO_ACCEPTANCE_CRITERIA}

## Priority
${WO_PRIORITY}

## Tags
${WO_TAGS}

## Instructions
1. Complete ALL acceptance criteria listed above.
2. Use the Supabase MCP tools for database operations (execute_sql, apply_migration, list_tables).
3. Use bash for shell commands, git operations, and supabase CLI.
4. When ALL ACs are complete, run this SQL via the Supabase MCP execute_sql tool:
   SELECT wo_transition('${WO_ID}'::uuid, 'submit_for_review', '{\"summary\":\"All ACs completed\"}'::jsonb, 'builder', 0, NULL);
5. If you cannot complete the work, run:
   SELECT wo_transition('${WO_ID}'::uuid, 'mark_failed', '{\"failure_reason\":\"<reason>\"}'::jsonb, 'builder', 0, NULL);

Execute the work order now."

echo "[opencode-runner] Model: $MODEL"
echo "[opencode-runner] Working dir: /workspace"

# Run OpenCode non-interactively
cd /workspace
opencode run \
  --model "$MODEL" \
  "$WO_PROMPT" \
  2>&1 | tee /var/log/sprite/opencode.log

EXIT_CODE=${PIPESTATUS[0]}

echo "[opencode-runner] OpenCode exited with code $EXIT_CODE"
exit $EXIT_CODE
