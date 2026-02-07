# ENDGAME-001 Tech Stack
*Auto-generated from live system state at 2026-02-06 18:25:31.187931+00*

## Infrastructure
- **Database**: Supabase PostgreSQL (project: phfblljwuvzqzlbzkzpr)
- **Edge Functions**: Supabase Edge Functions (Deno runtime)
- **Portal**: Vercel (metis-portal2)
- **Daemon**: Python (launchd-managed, polling mode)
- **Observability**: Langfuse

## Tables (50)
- **agent_memory**: Per-agent memory storage
- **agent_quotas**: Per-agent rate limit quotas
- **agents**: Agent registry
- **allowed_actions**: Registry of allowed LLM actions with validation rules
- **audit_log**: Immutable audit trail for all system events
- **audits**: Audit records
- **backlog**: Feature backlog
- **component_dependencies**: Tracks dependencies between manifest components
- **consensus_votes**: Multi-agent consensus tracking for work order approval
- **conversation_threads**: Portal chat threads
- **conversations**: Conversation storage
- **decisions**: Decision log
- **entities**: Entity registry
- **entity_relationships**: Entity relationship graph
- **facts**: Fact storage
- **feedback_log**: User feedback storage
- **implementations**: Work order implementations
- **langfuse_traces**: Langfuse trace storage
- **memories**: Memory storage
- **message_embeddings**: Message embedding storage
- **messages**: Legacy message storage
- **model_capabilities**: Model capability tracking
- **model_pricing**: Model pricing data
- **open_source_tools**: OSS tool registry
- **orchestrator_config_audit**: Config audit trail
- **orchestrator_configs**: Orchestrator configuration
- **pending_migrations**: Stores SQL migrations for Claude Code CLI to execute. Each row is an atomic migration with up/down SQL.
- **preferences**: Legacy preference storage
- **project_briefs**: Project definitions
- **project_context**: Project state
- **qa_findings**: QA agent findings for work order validation
- **query_log**: Query logging
- **rate_limit_log**: Log of rate limit checks
- **request_schemas**: JSON schemas for endpoint request validation
- **routing_rules**: Model routing rules
- **schema_changes**: DDL audit log
- **secrets**: Secret storage
- **state_mutations**: Audit log for all state changes through state_write function
- **system_directives**: Behavioral directives
- **system_manifest**: Component registry
- **system_status**: Component health tracking
- **thread_messages**: Thread message storage
- **tool_calls**: Tool call logging
- **transcripts**: Orchestrator transcripts
- **user_preferences**: User preference storage
- **webhook_logs**: Webhook event logs
- **work_order_execution_log**: Execution phase logging
- **work_orders**: Work order tracking
- **workspace_events**: Workspace event stream
- **workspace_locks**: Resource locking

## Edge Functions (26)
- **approval-notify** (v1): Notification service for WO approval events
- **context-load** (v13): Parallel-fetch 13 data sources: agents, WOs, directives, project briefs, phase status, lessons, daemon status, recent completions. Powers CLAUDE.md generation and health dashboard.
- **context-refresh** (v1): Returns fresh CLAUDE.md or JSON context for Claude Code CLI
- **context-sync** (v1): Sync context across components
- **evaluate-gates** (v1): Gate evaluation engine — checks approval gates before WO transitions
- **get-thread** (v2): Get single thread
- **github-deploy** (v2): GitHub deployment integration
- **interrogate** (v1): Project interrogation engine — asks 13 structured questions across 7 domains to build project context
- **langfuse** (v7): Langfuse observability integration
- **list-threads** (v2): List conversation threads
- **mcp-gateway** (v1): MCP gateway for tool routing
- **memory-ingest** (v9): Ingest conversations into memory system
- **memory-recall** (v9): Semantic search over conversation history
- **notion-sync** (v6): Sync data to Notion
- **orchestrate** (v21): Request orchestration and routing
- **portal-chat** (v37): Main chat interface for METIS orchestration
- **portal-directives** (v6): Directive management
- **portal-memory-sync** (v7): Memory sync for portal
- **portal-threads** (v6): Thread management for portal
- **session-capture** (v10): Capture and persist session state
- **storage-upload** (v7): File upload handling
- **sync-notion** (v1): Alternative Notion sync
- **work-order** (v8): Work order CRUD
- **work-order-executor** (v18): Work order lifecycle management
- **work-order-webhook** (v1): Webhook for work order events
- **workspace-api** (v1): Workspace management API

## Phase Status
[{"name": "Foundation", "phase": 1, "status": "complete", "description": "Schema, triggers, edge functions, portal-chat, observability"}, {"name": "Enforcement", "phase": 2, "status": "complete", "description": "WO validator, gate evaluator, intake loop"}, {"name": "Learning", "phase": 3, "status": "complete", "description": "Auto-lessons, directive promotion, self-update via WO"}, {"name": "Autonomy", "phase": 4, "status": "active", "description": "Daemon active, auto-routing, context enriched. Remaining: visibility, doc-sync, auto-approval", "completion_pct": 90}, {"name": "Build Pipeline", "phase": 5, "status": "complete", "description": "Conversational intake, WO decomposition, project-aware daemon, code delivery"}]
