# ENDGAME-001 System Architecture
**Auto-generated**: 2026-02-07 05:31:27 UTC

## Tables

Total: 67

| Table | Columns | RLS |
|-------|---------|-----|
| active_sessions | 8 | No |
| agent_memory | 9 | Yes |
| agent_quotas | 8 | Yes |
| agents | 8 | Yes |
| allowed_actions | 11 | Yes |
| approval_queue | 14 | No |
| audit_log | 14 | Yes |
| audits | 17 | No |
| auto_approval_log | 7 | Yes |
| backlog | 14 | No |
| bypass_log | 11 | No |
| component_dependencies | 5 | Yes |
| consensus_votes | 7 | Yes |
| conversation_threads | 14 | Yes |
| conversations | 16 | No |
| decision_gates | 12 | No |
| decisions | 17 | Yes |
| directive_versions | 11 | No |
| entities | 10 | No |
| entity_relationships | 9 | No |
| facts | 13 | No |
| feedback_log | 6 | No |
| implementations | 17 | No |
| intake_log | 15 | Yes |
| interrogation_sessions | 15 | No |
| langfuse_traces | 15 | No |
| lessons | 24 | No |
| mcp_request_log | 8 | No |
| message_embeddings | 6 | No |
| messages | 12 | No |
| metis_capabilities | 9 | No |
| metis_capability_metrics | 11 | No |
| model_capabilities | 41 | No |
| model_pricing | 10 | No |
| open_source_tools | 15 | No |
| orchestrator_config_audit | 8 | No |
| orchestrator_configs | 7 | No |
| pending_migrations | 17 | No |
| preferences | 9 | No |
| project_briefs | 21 | No |
| project_context | 11 | Yes |
| project_documents | 13 | No |
| qa_findings | 11 | Yes |
| query_log | 8 | No |
| rate_limit_log | 8 | Yes |
| request_schemas | 8 | Yes |
| routing_rules | 15 | No |
| schema_changes | 9 | Yes |
| secrets | 3 | Yes |
| spans | 22 | No |
| state_mutations | 12 | Yes |
| system_config_versions | 11 | No |
| system_directives | 16 | Yes |
| system_manifest | 15 | Yes |
| system_status | 6 | No |
| thread_messages | 19 | Yes |
| tool_calls | 13 | No |
| trace_events | 9 | No |
| traces | 18 | No |
| transcripts | 31 | No |
| user_preferences | 7 | No |
| verification_log | 7 | No |
| webhook_logs | 6 | No |
| work_order_execution_log | 7 | Yes |
| work_orders | 38 | Yes |
| workspace_events | 7 | Yes |
| workspace_locks | 8 | Yes |

## Edge Functions

| Name | Version | Description |
|------|---------|-------------|
| approval-notify | N/A | Notification service for WO approval events |
| context-load | 10 | Parallel-fetch 13 data sources: agents, WOs, directives, project briefs, phase status, lessons, daemon status, recent co |
| context-refresh | N/A | Returns fresh CLAUDE.md or JSON context for Claude Code CLI |
| context-sync | 1 | Sync context across components |
| evaluate-gates | N/A | Gate evaluation engine — checks approval gates before WO transitions |
| get-thread | 2 | Get single thread |
| github-deploy | 1 | GitHub deployment integration |
| interrogate | N/A | Project interrogation engine — asks 13 structured questions across 7 domains to build project context |
| langfuse | 7 | Langfuse observability integration |
| list-threads | 2 | List conversation threads |
| mcp-gateway | N/A | MCP gateway for tool routing |
| memory-ingest | 9 | Ingest conversations into memory system |
| memory-recall | 9 | Semantic search over conversation history |
| notion-sync | 6 | Sync data to Notion |
| orchestrate | 21 | Request orchestration and routing |
| portal-chat | 43 | Chat API with plan mode, conversational intake, plan exit, and build guard functionality |
| portal-directives | 6 | Directive management |
| portal-memory-sync | 7 | Memory sync for portal |
| portal-threads | 6 | Thread management for portal |
| session-capture | 10 | Capture and persist session state |
| storage-upload | 7 | File upload handling |
| sync-notion | 1 | Alternative Notion sync |
| test-deploy-fail | 2 | Test edge function for deployment validation gate testing |
| work-order | 8 | Work order CRUD |
| work-order-executor | N/A | Work order lifecycle management with deployment validation (v23) and QA checklist validation (v24) |
| work-order-webhook | 1 | Webhook for work order events |
| workspace-api | 1 | Workspace management API |

## RPC Functions

Total: 43

| Name | Purpose |
|------|---------|
| acquire_lock | Get lock on resource |
| audit_config_changes | Log config mods |
| audit_logger | Logs events to immutable audit trail |
| auto_create_gap_wo | Phase 3.3: Self-update - auto WO creation |
| check_build_duplicates | Search for existing components that may overlap with proposed builds |
| check_consensus | Check if work order has multi-agent consensus to complete |
| check_rate_limit | Checks and enforces rate limits for agents |
| check_wo_needs_interrogation | Checks if complex WO needs interrogation before execution |
| claim_work_order | Atomic claim |
| complete_harness_span | Completes a harness span with output/status |
| complete_wo_trace | Completes a work order trace with totals |
| complete_work_order | Mark WO done |
| create_draft_work_order | Allows MCP bridge and CLI to create new draft work orders |
| detect_lesson_gaps | Phase 3.3: Self-update - gap detection |
| emit_harness_span | Emits a span for harness operations |
| estimate_cost | Calculate expected cost |
| exec_sql | Dynamic SQL |
| execute_pending_migration | Allow Claude Code CLI to execute migrations with proper error handling. |
| get_model_price | Lookup model price |
| get_next_migration | Enable Claude Code CLI to process migrations in correct order. |
| get_routing_decision | Select model |
| increment_retrieval_count | Track retrieval |
| intent_extractor | Extracts and validates tool calls from LLM responses |
| log_harness_error_as_lesson | Logs harness errors to lessons table for self-improvement |
| manifest_guard | Pre-write validation for manifest - checks duplicates and similar components |
| notify_notion_sync | pg_notify for Notion |
| notify_work_order_webhook | pg_notify for WO |
| qa_review | QA agent review function - validates work order completion |
| release_lock | Free lock |
| search_conversations_ranked | BM25 search |
| search_conversations_semantic | Vector similarity search over conversation embeddings |
| set_agent_context | RLS context |
| start_wo_trace | Starts a trace for work order execution lifecycle |
| state_read | Controlled read function for database queries with filtering. |
| state_rollback | Rollback function to undo mutations using captured previous state. |
| state_write | Single-path mutation function for all database writes. Enforces WO requirements, logs all changes. |
| store_conversation_messages | Bulk insert |
| update_thread_stats | Update counts |
| update_work_order_state | Protected WO state updates with bypass flag |
| validate_deployment_readiness | Deployment gate function that checks: (1) required env vars exist in secrets table, (2) build status is success in execution logs, (3) deployment logs |
| validate_request | Validates incoming requests against schemas |
| validate_wo_transition | Validates all WO transitions against allowed state machine paths. Enforces preconditions for each target status. Includes deployment validation gate ( |
| wo_enforcer | Validates work order is approved and in executable state. |

## Triggers

- **audit_log_immutable**: Prevents UPDATE/DELETE on audit_log
- **audit_orchestrator_configs**: Config audit trigger
- **auto-route-trigger**: DB trigger auto-assigns WOs to agents on approval based on tags
- **enforce_state_write**: Blocks direct mutations on protected tables, requires state_write()
- **enforce_wo_state_changes**: Blocks direct WO status/approval changes
- **generate_project_documents**: Auto-generates 8 canonical project documents on project_briefs INSERT (PRD, app_flow, tech_stack, frontend_guidelines, backend_structure, implementati
- **sync_audits_to_notion**: Notion sync for audits
- **sync_implementations_to_notion**: Notion sync for implementations
- **sync_work_orders_to_notion**: Notion sync for work orders
- **trg_update_thread_stats**: Thread stats update
- **work_order_webhook_trigger**: Work order webhook

## Views

- **active_decisions**: Active decisions view
- **conversations_ranked**: Ranked conversations
- **conversations_with_stats**: Conversation stats view
- **v_audit_issues**: Audit issues
- **v_audit_timeline**: Timeline view of audit events with agent and WO context
- **v_engineering_queue**: Engineering queue
- **v_recent_completions**: Recent completions
- **v_system_health**: System health
- **v_work_orders_attention**: Work orders needing attention
- **valid_facts**: Valid facts view

## Enums

- **agent_type**: you, engineering, audit, cto, cpo, research, analysis, external
- **audit_severity**: info, warning, error, critical
- **audit_type**: scheduled, post_deploy, incident, manual
- **conversation_source**: claude_web, claude_api, gpt, slack, email, manual, n8n, claude_export, portal
- **decision_status**: active, superseded, reversed, pending
- **decision_type**: technical, strategic, operational, financial, legal
- **entity_type**: person, company, project, deal, agent
- **fact_category**: stable, temporal, derived
- **implementation_status**: started, testing, failed, succeeded, deployed_staging, deployed_prod, rolled_back
- **message_role**: user, assistant, system, tool
- **org_type**: aexodus, basetwo, personal, master_layer
- **preference_scope**: user, agent, system, org
- **query_intent**: entity_lookup, decision_recall, preference_check, conversation_search, exploratory
- **work_order_complexity**: trivial, small, medium, large, unknown
- **work_order_priority**: p0_critical, p1_high, p2_medium, p3_low
- **work_order_status**: draft, ready, pending_approval, in_progress, blocked, review, done, cancelled

## Recent Schema Changes (30d)

- [2026-02-03] create_table table work_order_execution_log: Enable granular execution phase tracking for work orders
- [2026-02-03] create_table table metis_capabilities: Self-awareness registry for Metis capabilities
- [2026-02-03] create_table table metis_capability_metrics: Performance telemetry per capability
- [2026-02-03] create_table table schema_changes: DDL audit log to prevent schema drift

## Decision Gates

- **approve_external_api** (external_api): Human approval for new external APIs
- **approve_high_cost** (cost_threshold): Human approval if cost > $5
- **approve_schema_changes** (state_mutation): Human approval for DDL
- **auto_p3_work** (work_order_execute): Auto-execute P3 low priority work
- **auto_state_safe** (state_mutation): Auto-approve safe state mutations

## System Stats

- Tables: 67
- Manifest entries: 162
- Lessons: 102
- Active directives: 19
- Work orders (total/done): 109/73
