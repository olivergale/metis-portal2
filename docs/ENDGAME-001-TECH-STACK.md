# ENDGAME-001 Tech Stack

> Pinned versions, dependencies, and infrastructure.
> Last updated: 2026-02-06

## Infrastructure

| Component | Provider | Details |
|-----------|----------|---------|
| **Database** | Supabase Postgres | Project `phfblljwuvzqzlbzkzpr`, pgvector enabled |
| **Edge Functions** | Supabase (Deno) | 29 deployed functions |
| **Portal Hosting** | Vercel | Static HTML, auto-deploy from `olivergale/metis-portal2` |
| **MCP Bridge** | Self-hosted | FastAPI on macOS, cloudflared tunnel to `mcp.authenticrevolution.com` |
| **Daemon** | Self-hosted | Python 3, launchd on macOS |
| **Observability** | Langfuse | Self-hosted, traces via edge function proxy |
| **Git** | GitHub | `olivergale/endgame-ilmarinen`, `olivergale/metis-portal2` |

## Supabase

- **Project ID**: `phfblljwuvzqzlbzkzpr`
- **API URL**: `https://phfblljwuvzqzlbzkzpr.supabase.co`
- **Extensions**: pgvector, pg_cron, pg_trgm (full-text search)
- **Auth**: Anon key (JWT), no user auth — system-to-system only
- **RLS**: Enabled on 25/65 tables (enforcement + core tables)
- **Cron**: 2 jobs (lesson-promoter every 6h, span reaper every 5m)

## Edge Function Runtime

- **Runtime**: Deno (Supabase-managed)
- **TypeScript**: Strict mode
- **Key imports**:
  - `@supabase/supabase-js` — Supabase client
  - `jsr:@supabase/functions-js/edge-runtime.d.ts` — Edge runtime types
  - Anthropic SDK (portal-chat, intake-api, lesson-promoter)
  - Langfuse SDK (portal-chat)

## Portal (Frontend)

- **Framework**: None — vanilla HTML/CSS/JS
- **Pages**: `index.html` (chat), `workspace.html` (WO management), `health.html` (dashboard)
- **Styling**: CSS custom properties (design tokens in `:root`)
- **Fonts**: Inter (Google Fonts CDN)
- **Build**: None — static files, Vercel auto-deploys on push
- **API calls**: Direct to Supabase edge functions via `fetch()`

## MCP Bridge

- **Framework**: FastAPI (Python)
- **Server**: `server.py` — SSE-based MCP protocol bridge
- **Port**: 8080
- **Tunnel**: cloudflared → `mcp.authenticrevolution.com/mcp`
- **Purpose**: Bridges Claude.ai (cloud) to local Supabase via MCP protocol
- **Startup**: `run.sh` or `start-persistent.sh`
- **Python env**: venv at `/Users/OG/mcp-http-bridge/venv/`

## Daemon (Ilmarinen Executor)

- **Language**: Python 3
- **File**: `~/.claude/ilmarinen-daemon-v2.py`
- **Process manager**: launchd (`com.endgame.ilmarinen.plist`)
- **Mode**: Polling (10s interval)
- **Execution**: Spawns `claude` CLI subprocess for each approved WO
- **Config**: `~/.claude/ilmarinen-daemon.env` (API keys, chmod 600)
- **Kill switch**: `daemon_kill_switch` in `user_preferences` table
- **Logging**: stdout/stderr to launchd log

## CLI Tools

### `wo` (Work Order CLI)
- **Location**: `/Users/OG/Projects/wo`
- **Language**: Bash
- **Commands**: `list`, `brief`, `create`, `start`, `review`, `done`, `cancel`
- **API**: Calls Supabase REST + RPCs directly via `curl`

### `ilmarinen-poller.py`
- **Location**: `~/.claude/ilmarinen-poller.py`
- **Language**: Python 3
- **Purpose**: Manual WO polling with `--watch` mode
- **Usage**: Development/debugging tool

## External APIs

| API | Purpose | Used By |
|-----|---------|---------|
| **Anthropic Claude** | LLM (chat, classification, execution) | portal-chat, intake-api, lesson-promoter, daemon (via CLI) |
| **Langfuse** | Observability traces | portal-chat (direct integration) |
| **OpenAI** | Embeddings (ada-002) | memory-ingest, memory-recall |
| **GitHub** | Source control, deployment trigger | Vercel auto-deploy, github-deploy edge fn |
| **Notion** | Sync WOs/audits/implementations | notion-sync, sync-notion triggers |

## Design Tokens (CSS)

Defined in `:root` across portal pages:

```css
--bg-primary: #2b2a27
--bg-surface: #353432
--bg-elevated: #3f3e3b
--bg-hover: #4a4946
--text-primary: #ececec
--text-secondary: #b8b8b6
--text-muted: #888886
--border-default: #4a4946
--border-strong: #5a5956
--accent: #d4a574
--accent-hover: #e0b588
--accent-subtle: rgba(212, 165, 116, 0.15)
--status-active: #34D399
--status-warning: #FBBF24
--status-error: #F87171
--status-muted: #9CA3AF
```

## Key Model Usage

| Context | Model | Purpose |
|---------|-------|---------|
| Portal chat | Claude Sonnet 4.5 | Main conversation + tool use |
| Intake classification | Claude Haiku 4.5 | Fast request classification |
| Lesson promotion | Claude Haiku 4.5 | Lesson analysis + gap detection |
| Daemon execution | Claude (via CLI) | WO execution |
| Embeddings | OpenAI ada-002 | Semantic search vectors |
