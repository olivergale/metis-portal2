# ENDGAME-001 Architecture Reference

> Auto-generated from live Supabase introspection. WO-ARCH-AUDIT.
> Last updated: 2026-02-06

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  METIS Portal (Vercel)                                              │
│  index.html · workspace.html · health.html                         │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐             │
│  │ portal-chat  │  │ workspace UI │  │ health dashboard│            │
│  └──────┬───────┘  └──────┬───────┘  └───────┬────────┘            │
└─────────┼──────────────────┼──────────────────┼─────────────────────┘
          │                  │                  │
          ▼                  ▼                  ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Supabase Edge Functions (Deno runtime)                             │
│  portal-chat v36 │ work-order-executor v13 │ context-load v13      │
│  intake-api v2   │ lesson-promoter v3      │ + 24 more             │
└─────────┬───────────────────┬───────────────────┬───────────────────┘
          │                   │                   │
          ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Supabase Postgres (source of truth)                                │
│  65 tables · 35 triggers · 100+ RPCs · 16 views · 16 enums         │
│  RLS on 25 tables · Enforcement via state_write() + triggers        │
└─────────────────────┬───────────────────────────────────────────────┘
                      │
          ┌───────────┼───────────┐
          ▼           ▼           ▼
┌──────────────┐ ┌──────────┐ ┌─────────────────┐
│ Daemon (py3) │ │ wo CLI   │ │ MCP Bridge      │
│ launchd      │ │ bash     │ │ FastAPI+tunnel   │
│ polls WOs    │ │ lifecycle│ │ Claude.ai↔Supa   │
│ runs Claude  │ │ mgmt     │ │ 8080→cloudflared │
└──────────────┘ └──────────┘ └─────────────────┘
```

## Data Flow

### Request → Execution → Learning Loop

```
1. User message (Portal or Claude.ai)
       │
2. intake-api classifies (Haiku LLM)
       ├─ chat → portal-chat (direct response)
       └─ task → create_draft_work_order() RPC
              │
3. WO lifecycle: draft → ready → in_progress → review → done
       │  enforce_wo_state_changes trigger validates every transition
       │  auto_route_work_order trigger assigns agent on ready
       │
4. Daemon polls work-order-executor/poll
       │  Claims WO → runs Claude CLI → completes WO
       │
5. Spans emitted during execution
       │  trg_auto_lesson_on_error_span → creates lesson from errors
       │
6. lesson-promoter (cron 6h) promotes lessons → directives
       │  detect_lesson_gaps() finds recurring patterns
       │  auto_create_gap_wo() creates self-improvement WOs
       │
7. Directives loaded into portal-chat system prompt
       └─ Loop closes: errors → lessons → directives → better responses
```

## Edge Functions (29 deployed)

| Slug | Version | verify_jwt | Purpose |
|------|---------|------------|---------|
| `portal-chat` | v36 | false | Main chat — loads directives, Langfuse traces |
| `work-order-executor` | v13 | false | WO lifecycle: poll/claim/complete/fail/approve/status |
| `context-load` | v13 | false | Parallel-fetch 13 data sources for context |
| `intake-api` | v2 | false | Request classification + WO creation |
| `lesson-promoter` | v3 | false | Tier 1-4 lesson promotion, cron: `0 */6 * * *` |
| `orchestrate` | v21 | false | Request orchestration and routing |
| `session-capture` | v10 | false | Capture and persist session state |
| `memory-ingest` | v9 | false | Ingest conversations into memory |
| `memory-recall` | v9 | false | Semantic search over conversation history |
| `work-order` | v8 | false | Work order CRUD |
| `portal-memory-sync` | v7 | false | Memory sync for portal |
| `storage-upload` | v7 | false | File upload handling |
| `langfuse` | v7 | false | Langfuse observability integration |
| `notion-sync` | v6 | false | Sync data to Notion |
| `portal-threads` | v6 | false | Thread management for portal |
| `portal-directives` | v6 | false | Directive management |
| `generate-docs` | v4 | false | Auto-generate project documents |
| `lesson-promoter` | v3 | false | (same as above — single slug) |
| `list-threads` | v2 | false | List conversation threads |
| `get-thread` | v2 | false | Get single thread |
| `workspace-api` | v1 | **true** | Workspace management API (only JWT-protected) |
| `mcp-gateway` | v1 | false | MCP protocol gateway |
| `approval-notify` | v1 | false | Notification on WO approval |
| `work-order-webhook` | v1 | false | Webhook handler for WO events |
| `context-sync` | v1 | false | Sync context across components |
| `context-refresh` | v1 | false | Returns fresh CLAUDE.md for CLI |
| `github-deploy` | v1 | false | GitHub deployment integration |
| `sync-notion` | v1 | false | Alternative Notion sync |
| `evaluate-gates` | v1 | false | Decision gate evaluation |
| `interrogate` | v1 | false | Project interrogation flow |

**Note**: Only `workspace-api` requires JWT. All others use anon key auth.

## RPC Functions (application-level, excluding pgvector/internal)

### Enforcement RPCs (SECURITY DEFINER)

| Function | Params | Purpose |
|----------|--------|---------|
| `state_write` | `mutation_type, target_table, payload, [wo_id, agent_id, session_id]` | Single mutation path for protected tables. Logs to state_mutations, sets bypass flags. |
| `update_work_order_state` | `wo_id, [status, approved_at, approved_by, started_at, completed_at, summary]` | Protected WO state updates with bypass flag. |
| `start_work_order` | `wo_id, [agent_name='ilmarinen']` | Atomic assign+approve+start (draft→ready→in_progress). |
| `create_draft_work_order` | `name, slug, objective, [priority, source, tags]` | Bootstrap RPC for new WOs without existing WO context. |
| `claim_work_order` | `agent_name, wo_id` | Daemon claims a WO for execution. |
| `complete_work_order` | `agent_name, wo_id, [result]` | Marks WO done with result payload. |
| `auto_create_gap_wo` | `category, pattern, rule, [severity]` | Creates self-improvement WOs from lesson gaps. Idempotent. |

### Observability RPCs

| Function | Params | Purpose |
|----------|--------|---------|
| `emit_harness_span` | `trace_id, span_type, name, [input, metadata]` | Emit span for harness operations. |
| `complete_harness_span` | `span_id, [output, status, error_message, cost, tokens, latency, metadata]` | Complete a span with output/status. |
| `start_wo_trace` | `wo_id, [session_id]` | Start trace for WO execution lifecycle. |
| `complete_wo_trace` | `trace_id, [status, output, error_message]` | Complete a WO trace. |
| `audit_logger` | `event_type, actor_type, actor_id, action, [target_type, target_id, payload, ...]` | Immutable audit trail logging. |
| `log_harness_error_as_lesson` | `error_message, [context, category, wo_id, trace_id]` | Log harness errors to lessons table. |

### Validation RPCs

| Function | Params | Purpose |
|----------|--------|---------|
| `validate_wo_transition` | `old_status, new_status, wo_record` | Validates state transitions with preconditions. |
| `wo_enforcer` | `wo_id` | Validates WO is approved and executable. |
| `check_allowed_action` | `action_name, [agent_id, wo_id]` | Checks action against allowed_actions registry. |
| `check_directive_compliance` | `check_point, [context]` | Validates against active directives. |
| `validate_request` | `endpoint, method, body, [headers]` | Validates incoming requests against schemas. |
| `manifest_guard` | `name, component_type, [wo_id]` | Pre-write duplicate check for manifest. |
| `qa_review` | `wo_id, [agent_id]` | QA validation for WO completion. |
| `check_consensus` | `wo_id` | Multi-agent consensus check. |

### Query RPCs

| Function | Params | Purpose |
|----------|--------|---------|
| `state_read` | `target_table, [filters, limit]` | Controlled read with filtering. |
| `detect_lesson_gaps` | (none) | Finds recurring lesson patterns (≥3 same category). |
| `get_lesson_category_counts` | (none) | Lesson stats by category/severity. |
| `generate_claude_md` | `[project_code]` | Generates CLAUDE.md content. |
| `get_session_summary` | `[project_code, since]` | Session summary for project. |
| `search_conversations_semantic` | `query_embedding, [threshold, count, filters]` | Semantic conversation search. |
| `search_conversations_ranked` | `query_embedding, [threshold, count, half_life_days]` | Ranked search with recency/frequency boost. |

### Lifecycle RPCs

| Function | Params | Purpose |
|----------|--------|---------|
| `promote_lesson_to_directive` | `lesson_id, [type, enforcement, priority, promoted_by]` | Promotes lesson → directive. |
| `acquire_lock` / `release_lock` | `agent_name, resource_type, resource_id, ...` | Resource locking for concurrent access. |
| `check_rate_limit` | `agent_id, [quota_type]` | Rate limit enforcement. |
| `autoroute_work_order` | `wo_id` | Manual routing trigger. |
| `request_approval` | `wo_id, request_type, summary, detail, requested_by` | Request approval for WO. |

## Database Triggers (35 active)

### Enforcement Triggers

| Trigger | Table | Timing | Function | Purpose |
|---------|-------|--------|----------|---------|
| `enforce_wo_state_changes_trigger` | work_orders | BEFORE UPDATE | `enforce_wo_state_changes` | Blocks direct status/approval changes. Requires bypass via `update_work_order_state`. |
| `enforce_state_write_trigger` | decisions | BEFORE INSERT | `enforce_state_write` | Blocks direct inserts. Requires `state_write()`. |
| `enforce_state_write_trigger` | schema_changes | BEFORE INSERT | `enforce_state_write` | Same enforcement for schema changes. |
| `enforce_state_write_trigger` | system_manifest | BEFORE INSERT | `enforce_state_write` | Same enforcement for manifest. |
| `trg_audit_log_immutable` | audit_log | BEFORE DELETE | `audit_log_immutable` | Prevents deletes on audit_log. |
| `trg_spans_append_only` | spans | BEFORE DELETE | `enforce_append_only` | Spans are append-only. |
| `trg_traces_append_only` | traces | BEFORE DELETE | `enforce_append_only` | Traces are append-only. |
| `trg_trace_events_append_only` | trace_events | BEFORE DELETE | `enforce_append_only` | Trace events are append-only. |

### Auto-routing Triggers

| Trigger | Table | Timing | Function | Purpose |
|---------|-------|--------|----------|---------|
| `trg_auto_route_work_order` | work_orders | BEFORE UPDATE | `auto_route_work_order` | Auto-assigns agent on status→ready based on tags. |
| `autoroute_new_wo` | work_orders | AFTER INSERT | `trigger_autoroute_new_wo` | Auto-route on new WO creation. |
| `set_wo_source_trigger` | work_orders | BEFORE INSERT | `set_work_order_source` | Sets WO source metadata on creation. |

### Learning Triggers

| Trigger | Table | Timing | Function | Purpose |
|---------|-------|--------|----------|---------|
| `trg_auto_lesson_on_error_span` | spans | AFTER INSERT | `create_lesson_from_error_span` | Error span → auto-creates lesson. |
| `trg_auto_promote_critical_lesson` | lessons | AFTER INSERT | `auto_promote_critical_lesson` | Critical lessons auto-promoted. |
| `trg_update_wo_lesson_count` | lessons | AFTER INSERT | `update_wo_lesson_count` | Updates WO lesson count on new lesson. |

### Notification Triggers

| Trigger | Table | Timing | Function | Purpose |
|---------|-------|--------|----------|---------|
| `sync_work_orders_to_notion` | work_orders | AFTER INSERT | `notify_notion_sync` | Sync WOs to Notion. |
| `sync_audits_to_notion` | audits | AFTER INSERT | `notify_notion_sync` | Sync audits to Notion. |
| `sync_implementations_to_notion` | implementations | AFTER INSERT | `notify_notion_sync` | Sync implementations to Notion. |
| `work_order_webhook_trigger` | work_orders | AFTER INSERT | `notify_work_order_webhook` | Fire webhook on new WO. |

### Housekeeping Triggers

| Trigger | Table | Timing | Function | Purpose |
|---------|-------|--------|----------|---------|
| `work_orders_updated_at` | work_orders | BEFORE UPDATE | `update_updated_at` | Auto-update timestamp. |
| `trigger_conversations_updated_at` | conversations | BEFORE UPDATE | `update_updated_at` | Auto-update timestamp. |
| `trigger_decisions_updated_at` | decisions | BEFORE UPDATE | `update_updated_at` | Auto-update timestamp. |
| `trigger_entities_updated_at` | entities | BEFORE UPDATE | `update_updated_at` | Auto-update timestamp. |
| `trigger_preferences_updated_at` | preferences | BEFORE UPDATE | `update_updated_at` | Auto-update timestamp. |
| `implementations_updated_at` | implementations | BEFORE UPDATE | `update_updated_at` | Auto-update timestamp. |
| `update_project_briefs_updated_at` | project_briefs | BEFORE UPDATE | `update_updated_at_column` | Auto-update timestamp. |
| `update_routing_rules_updated_at` | routing_rules | BEFORE UPDATE | `update_updated_at_column` | Auto-update timestamp. |
| `update_model_capabilities_updated_at` | model_capabilities | BEFORE UPDATE | `update_updated_at_column` | Auto-update timestamp. |
| `update_orchestrator_configs_updated_at` | orchestrator_configs | BEFORE UPDATE | `update_updated_at_column` | Auto-update timestamp. |
| `trg_update_thread_stats` | thread_messages | AFTER INSERT | `update_thread_stats` | Update thread message counts. |
| `audit_orchestrator_configs` | orchestrator_configs | AFTER INSERT | `audit_config_changes` | Audit config changes. |

### Project Intake Triggers

| Trigger | Table | Timing | Function | Purpose |
|---------|-------|--------|----------|---------|
| `project_briefs_generate_docs` | project_briefs | AFTER INSERT | `generate_project_documents` | Auto-generate docs on new project. |
| `trg_new_project_interrogation` | project_briefs | AFTER INSERT | `trigger_project_interrogation` | Auto-start interrogation on new project. |
| `trg_check_intake_complete` | project_documents | AFTER INSERT | `check_and_set_intake_complete` | Check if intake is complete. |
| `trigger_project_context_updated` | project_context | BEFORE UPDATE | `update_project_context_timestamp` | Timestamp update. |
| `trigger_project_context_updated_at` | project_context | BEFORE UPDATE | `update_project_context_updated_at` | Timestamp update. |

## Cron Jobs (pg_cron)

| Schedule | Command | Purpose |
|----------|---------|---------|
| `0 */6 * * *` | `SELECT invoke_lesson_promoter()` | Runs lesson-promoter edge function every 6 hours |
| `*/5 * * * *` | `SELECT reap_orphaned_spans()` | Cleans up orphaned spans every 5 minutes |

## Database Tables (65 total)

### Core Tables (RLS enabled)

| Table | Columns | Purpose |
|-------|---------|---------|
| `work_orders` | 36 | Work order tracking — central to WO lifecycle |
| `system_manifest` | 15 | Component registry — all system components |
| `system_directives` | 16 | Behavioral directives from promoted lessons |
| `state_mutations` | 12 | Audit log for all `state_write()` mutations |
| `audit_log` | 14 | Immutable audit trail (no UPDATE/DELETE) |
| `agents` | 8 | Agent registry (ilmarinen, audit, etc.) |
| `agent_memory` | 9 | Per-agent memory storage |
| `agent_quotas` | 8 | Rate limit quotas |
| `thread_messages` | 19 | Portal chat messages |
| `conversation_threads` | 13 | Portal chat threads |
| `decisions` | 17 | Decision log (state_write protected) |
| `schema_changes` | 9 | DDL audit log (state_write protected) |
| `workspace_events` | 7 | Workspace event stream |
| `workspace_locks` | 8 | Resource locking |
| `work_order_execution_log` | 7 | Execution phase logging |

### Supporting Tables (RLS varies)

| Table | Cols | RLS | Purpose |
|-------|------|-----|---------|
| `lessons` | 24 | off | Lesson storage from errors/spans |
| `spans` | 22 | off | Observability spans (append-only) |
| `traces` | 18 | off | Execution traces (append-only) |
| `project_briefs` | 20 | off | Project definitions with phases JSONB |
| `project_context` | 11 | on | Project state |
| `project_documents` | 13 | off | Auto-generated docs |
| `conversations` | 16 | off | Conversation storage |
| `transcripts` | 31 | off | Orchestrator transcripts |
| `implementations` | 17 | off | Work order implementations |
| `intake_log` | 15 | on | Intake classification log |
| `allowed_actions` | 11 | on | Action validation registry |
| `routing_rules` | 15 | off | Model routing rules |
| `model_capabilities` | 41 | off | Model capability tracking |
| `model_pricing` | 10 | off | Model pricing data |
| `orchestrator_configs` | 7 | off | Orchestrator configuration |
| `user_preferences` | 7 | off | User preference storage |
| `pending_migrations` | 17 | off | SQL migrations for CLI execution |
| `metis_capabilities` | 9 | off | **DEPRECATED** — replaced by system_manifest + agents |
| `langfuse_traces` | 15 | off | Langfuse trace storage |

### Utility Tables

| Table | Cols | Purpose |
|-------|------|---------|
| `entities` | 10 | Entity registry |
| `entity_relationships` | 9 | Entity relationship graph |
| `facts` | 13 | Fact storage |
| `feedback_log` | 6 | User feedback |
| `messages` | 12 | Legacy message storage |
| `message_embeddings` | 6 | Message embedding vectors |
| `open_source_tools` | 15 | OSS tool registry |
| `backlog` | 14 | Feature backlog |
| `secrets` | 3 | Secret storage |
| `query_log` | 8 | Query logging |
| `mcp_request_log` | 8 | MCP request logging |
| `webhook_logs` | 6 | Webhook event logs |
| `tool_calls` | 13 | Tool call logging |
| `trace_events` | 9 | Trace events (append-only) |
| `active_sessions` | 8 | Active session tracking |
| `approval_queue` | 14 | Approval queue |
| `audits` | 17 | Audit records |
| `bypass_log` | 11 | Bypass attempt logging |
| `consensus_votes` | 7 | Multi-agent consensus votes |
| `component_dependencies` | 5 | Manifest component dependencies |
| `decision_gates` | 12 | Decision gate definitions |
| `directive_versions` | 11 | Directive version history |
| `interrogation_sessions` | 15 | Project interrogation sessions |
| `orchestrator_config_audit` | 8 | Config audit trail |
| `preferences` | 9 | Legacy preferences |
| `qa_findings` | 10 | QA agent findings |
| `rate_limit_log` | 8 | Rate limit check log |
| `request_schemas` | 8 | JSON schemas for validation |
| `system_config_versions` | 11 | Config version history |
| `system_status` | 6 | Component health tracking |
| `metis_capability_metrics` | 11 | Capability metrics |

## Views (16)

| View | Purpose |
|------|---------|
| `v_system_health` | System health overview |
| `v_engineering_queue` | Engineering work queue |
| `v_work_orders_attention` | WOs needing attention |
| `v_recent_completions` | Recent WO completions |
| `v_audit_timeline` | Timeline of audit events with agent/WO context |
| `v_audit_issues` | Audit issues summary |
| `v_langfuse_traces` | Langfuse trace view with thread_id, status, tokens |
| `v_pending_migrations` | Pending migration queue |
| `v_active_config` | Active orchestrator config |
| `v_agent_costs` | Agent cost tracking |
| `active_decisions` | Active decisions |
| `conversations_ranked` | Ranked conversations |
| `conversations_with_stats` | Conversations with stats |
| `directive_enforcement_status` | Directive compliance status |
| `pending_approvals` | Pending approval queue |
| `valid_facts` | Valid facts view |

## Enums (16)

| Enum | Values |
|------|--------|
| `work_order_status` | draft, ready, pending_approval, in_progress, blocked, review, done, cancelled |
| `work_order_priority` | p0_critical, p1_high, p2_medium, p3_low |
| `work_order_complexity` | trivial, small, medium, large, unknown |
| `agent_type` | you, engineering, audit, cto, cpo, research, analysis, external |
| `audit_severity` | info, warning, error, critical |
| `audit_type` | scheduled, post_deploy, incident, manual |
| `conversation_source` | claude_web, claude_api, gpt, slack, email, manual, n8n, claude_export, portal |
| `decision_status` | active, superseded, reversed, pending |
| `decision_type` | technical, strategic, operational, financial, legal |
| `entity_type` | person, company, project, deal, agent |
| `fact_category` | stable, temporal, derived |
| `implementation_status` | started, testing, failed, succeeded, deployed_staging, deployed_prod, rolled_back |
| `message_role` | user, assistant, system, tool |
| `org_type` | aexodus, basetwo, personal, master_layer |
| `preference_scope` | user, agent, system, org |
| `query_intent` | entity_lookup, decision_recall, preference_check, conversation_search, exploratory |

## Local Tooling

| Component | Location | Status | Purpose |
|-----------|----------|--------|---------|
| `ilmarinen-daemon-v2.py` | `~/.claude/` | Running (launchd PID 77010) | Polls for approved WOs, executes via Claude CLI |
| `ilmarinen-daemon.env` | `~/.claude/` | Active (chmod 600) | API keys for daemon |
| `ilmarinen-poller.py` | `~/.claude/` | Available | Manual CLI WO poller with --watch mode |
| `ilmarinen-daemon.py` | `~/.claude/` | Legacy | Original daemon (v1) |
| `metis_hooks.py` | `~/.claude/hooks/` | Installed | Claude Code hooks: SessionStart, UserPromptSubmit, PreToolUse, PostToolUse |
| `work_order_hook.py` | `~/.claude/hooks/` | Installed, unused | Polls workspace-api for ready WOs |
| `wo` | `/Users/OG/Projects/wo` | Working | Bash CLI for WO lifecycle management |
| `MCP bridge` | `/Users/OG/mcp-http-bridge/` | Running | FastAPI server on port 8080 → cloudflared tunnel → mcp.authenticrevolution.com |
| `launchd plist` | `~/Library/LaunchAgents/com.endgame.ilmarinen.plist` | Loaded | KeepAlive, RunAtLoad daemon management |

## System Manifest Audit Findings

### Duplicate/Stale Entries
- `context-load` AND `context-load-v12` both in manifest — live slug is `context-load` (v13)
- `lesson-promoter-v3` in manifest but live slug is `lesson-promoter` (v3)
- `metis_capabilities` table marked deprecated — still queried by context-load (fixed in v13 to use `implementation` column)
- `project_ilmarinen` and `project_metis` marked deprecated — absorbed into ENDGAME-001

### Missing from Manifest
- `evaluate-gates` edge function — deployed but not in manifest
- `interrogate` edge function — deployed but not in manifest
- `generate-docs` edge function — deployed but not in manifest

### Version Drift
- All manifest entries have `version: 1` regardless of actual deployed version
- Live edge functions have real version numbers (e.g., portal-chat v36, context-load v13)
- Manifest does not track version changes

## Protected Table Matrix

| Table | Protection | Mechanism |
|-------|-----------|-----------|
| `work_orders` (status/approval cols) | `enforce_wo_state_changes` trigger | Requires `update_work_order_state()` RPC with bypass flag |
| `system_manifest` | `enforce_state_write` trigger | Requires `state_write()` RPC |
| `decisions` | `enforce_state_write` trigger | Requires `state_write()` RPC |
| `schema_changes` | `enforce_state_write` trigger | Requires `state_write()` RPC |
| `audit_log` | `audit_log_immutable` trigger | No UPDATE/DELETE allowed |
| `spans` | `trg_spans_append_only` trigger | No DELETE allowed |
| `traces` | `trg_traces_append_only` trigger | No DELETE allowed |
| `trace_events` | `trg_trace_events_append_only` trigger | No DELETE allowed |
