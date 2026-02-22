#!/bin/bash
# Generate AGENTS.md dynamically from Supabase tables
# Called by opencode-runner.sh before launching OpenCode
# Mirrors sprite-agent.ts buildSystemPrompt() logic — context is table-driven

set -e

OUTPUT="${1:-/workspace/AGENTS.md}"
AGENT_NAME="${AGENT_NAME:-builder}"

# Supabase connection — use service role key for direct DB access via REST API
SB_URL="${SUPABASE_URL}"
SB_KEY="${SUPABASE_SERVICE_ROLE_KEY}"

# Helper: query Supabase REST API and return JSON
sb_query() {
  local endpoint="$1"
  curl -sf "${SB_URL}/rest/v1/${endpoint}" \
    -H "apikey: ${SB_KEY}" \
    -H "Authorization: Bearer ${SB_KEY}" \
    -H "Content-Type: application/json" 2>/dev/null || echo "[]"
}

# Helper: call Supabase RPC
sb_rpc() {
  local fn="$1"
  local body="${2:-{}}"
  curl -sf "${SB_URL}/rest/v1/rpc/${fn}" \
    -H "apikey: ${SB_KEY}" \
    -H "Authorization: Bearer ${SB_KEY}" \
    -H "Content-Type: application/json" \
    -d "$body" 2>/dev/null || echo "null"
}

echo "[generate-agents-md] Building context for agent=$AGENT_NAME wo=$WO_SLUG"

# ── 1. Agent Execution Profile ───────────────────────────────────────
PROFILE=$(sb_query "agent_execution_profiles?agent_name=eq.${AGENT_NAME}&select=mission,error_style,custom_instructions&limit=1")
MISSION=$(echo "$PROFILE" | jq -r '.[0].mission // "Execute work orders"')
ERROR_STYLE=$(echo "$PROFILE" | jq -r '.[0].error_style // "retry with different strategy"')
CUSTOM_INSTRUCTIONS=$(echo "$PROFILE" | jq -r '.[0].custom_instructions // ""')

# ── 2. Directives (hard + soft) ──────────────────────────────────────
DIRECTIVES=$(sb_query "directives?active=eq.true&order=priority.asc&limit=30&select=name,content,enforcement,enforcement_mode")
HARD_DIRECTIVES=$(echo "$DIRECTIVES" | jq -r '[.[] | select(.enforcement == "hard" or .enforcement_mode == "hard")] | .[] | "- **\(.name)**: \(.content)"')
SOFT_DIRECTIVES=$(echo "$DIRECTIVES" | jq -r '[.[] | select(.enforcement != "hard" and .enforcement_mode != "hard")] | limit(10;.[]) | "- \(.name): \(.content)"')

# ── 3. Knowledge Base (critical/high for this agent) ─────────────────
KB=$(sb_query "agent_knowledge_base?active=eq.true&select=category,topic,content,severity,applicable_roles")
KB_FILTERED=$(echo "$KB" | jq -r --arg agent "$AGENT_NAME" '
  [.[] | select(
    (.severity == "critical" or .severity == "high") and
    ((.applicable_roles == null) or (.applicable_roles | length == 0) or (.applicable_roles | index($agent)))
  )] | .[] | "- [\(.category)/\(.severity)] \(.topic): \(.content)"')

# ── 4. Promoted Lessons ──────────────────────────────────────────────
LESSONS=$(sb_query "lessons?review_status=eq.approved&promoted_at=not.is.null&category=in.(schema,deployment,testing,enforcement,tool_usage,agent_behavior)&limit=20&select=pattern,rule,category")
LESSONS_TEXT=$(echo "$LESSONS" | jq -r '.[] | "- [\(.category)] \(.pattern): \(.rule)"')

# ── 5. Team Context (dynamic, from effects) ──────────────────────────
TEAM_CTX=$(sb_query "team_context?select=context_type,content&limit=10")
TEAM_CTX_TEXT=$(echo "$TEAM_CTX" | jq -r '.[] | "### \(.context_type)\n\(.content)\n"')

# ── 6. Concurrent WOs ────────────────────────────────────────────────
CONCURRENT=$(sb_query "work_orders?status=eq.in_progress&id=neq.${WO_ID}&select=slug,name&limit=10")
CONCURRENT_TEXT=$(echo "$CONCURRENT" | jq -r '.[] | "- \(.slug): \(.name)"')

# ── 7. WO-specific context (if remediation) ──────────────────────────
REMEDIATION_CTX=""
if echo "$WO_TAGS" | jq -e 'index("remediation")' >/dev/null 2>&1; then
  PARENT_ID=$(sb_query "work_orders?id=eq.${WO_ID}&select=parent_id&limit=1" | jq -r '.[0].parent_id // ""')
  if [ -n "$PARENT_ID" ] && [ "$PARENT_ID" != "null" ]; then
    PARENT_WO=$(sb_query "work_orders?id=eq.${PARENT_ID}&select=slug,name,objective&limit=1")
    PARENT_MUTS=$(sb_query "wo_mutations?work_order_id=eq.${PARENT_ID}&order=created_at.asc&select=tool_name,action,object_id,success,error_detail")
    PARENT_SLUG=$(echo "$PARENT_WO" | jq -r '.[0].slug // "unknown"')
    PARENT_NAME=$(echo "$PARENT_WO" | jq -r '.[0].name // "unknown"')
    PARENT_OBJ=$(echo "$PARENT_WO" | jq -r '.[0].objective // ""')
    OK_MUTS=$(echo "$PARENT_MUTS" | jq -r '[.[] | select(.success == true)] | .[] | "- \(.tool_name): \(.action) on \(.object_id)"')
    FAIL_MUTS=$(echo "$PARENT_MUTS" | jq -r '[.[] | select(.success == false)] | .[] | "- \(.tool_name): \(.action) on \(.object_id) — \(.error_detail // "unknown")"')
    REMEDIATION_CTX="## Remediation Context
Remediating ${PARENT_SLUG}: ${PARENT_NAME}
Original objective: ${PARENT_OBJ}

### Completed Mutations (DO NOT REDO)
${OK_MUTS}

### Failed Mutations (DO NOT RETRY same approach)
${FAIL_MUTS}
"
  fi
fi

# ── Assemble AGENTS.md ───────────────────────────────────────────────
cat > "$OUTPUT" << AGENTSEOF
# ENDGAME Sprite Agent — ${AGENT_NAME}

**Mission**: ${MISSION}
**Error handling**: ${ERROR_STYLE}

You are running inside a Fly Machine (Sprite) executing work order **${WO_SLUG}** (ID: ${WO_ID}).
You have full CLI access: bash, git, supabase CLI, plus the Supabase MCP server for database operations.

${CUSTOM_INSTRUCTIONS}

## Execution Rules
1. Complete ALL acceptance criteria before submitting for review.
2. Use the Supabase MCP tools for database operations (execute_sql, apply_migration, list_tables).
3. Use bash for shell commands, git operations, file verification.
4. When ALL ACs are complete, run via Supabase MCP execute_sql:
   \`SELECT wo_transition('${WO_ID}'::uuid, 'submit_for_review', '{"summary":"All ACs completed"}'::jsonb, '${AGENT_NAME}', 0, NULL);\`
5. If stuck or unable to complete, run:
   \`SELECT wo_transition('${WO_ID}'::uuid, 'mark_failed', '{"failure_reason":"<reason>"}'::jsonb, '${AGENT_NAME}', 0, NULL);\`
6. After DDL changes: run \`NOTIFY pgrst, 'reload schema'\` via execute_sql.
7. NEVER update work_orders directly — use wo_transition() RPC only.

## MANDATORY Directives
${HARD_DIRECTIVES}

## Advisory Directives
${SOFT_DIRECTIVES}

## Schema Knowledge
${KB_FILTERED}

## Learned Lessons
${LESSONS_TEXT}

## Critical Gotchas
- wo_transition() has 6 params: (p_wo_id, p_event, p_payload, p_actor, p_depth, p_signature)
- work_orders.name NOT title; .created_by is agent_type enum NOT UUID
- system_settings columns: setting_key/setting_value (NOT key/value)
- pgcrypto is in extensions schema: use extensions.digest()
- ACs must be numbered/bullets for count_acceptance_criteria() regex
- qa_checklist item status: pending, pass, fail, na (NOT passed)

${TEAM_CTX_TEXT}

$([ -n "$CONCURRENT_TEXT" ] && echo "## Concurrent Work Orders (avoid conflicts)
${CONCURRENT_TEXT}
")

${REMEDIATION_CTX}
AGENTSEOF

# Report size
AGENTS_SIZE=$(wc -c < "$OUTPUT")
echo "[generate-agents-md] Generated ${OUTPUT} (${AGENTS_SIZE} bytes)"
