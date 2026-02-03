# METIS Portal

## Overview

Frontend for METIS AI orchestration system. Deployed at https://metis-portal2.vercel.app

**Interfaces:**
- `index.html` - Chat Portal (conversational AI with markdown/syntax highlighting)
- `workspace.html` - Kanban Workspace (work order management)

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    METIS ORCHESTRATION                       │
├─────────────────────────────────────────────────────────────┤
│  METIS (Orchestrator)     │  ILMARINEN (Executor)           │
│  - Receives user intent   │  - Claims ready work orders     │
│  - Creates work orders    │  - Executes autonomously        │
│  - Routes to agents       │  - Submits for review           │
├─────────────────────────────────────────────────────────────┤
│                    SUPABASE BACKEND                          │
│  Project: phfblljwuvzqzlbzkzpr                              │
│  - Edge Functions (work-order-executor, portal-chat)        │
│  - PostgreSQL (work_orders, agents, events)                 │
└─────────────────────────────────────────────────────────────┘
```

## Critical Constraints

1. **Never bypass the harness** - All state mutations must go through `work-order-executor` API
2. **No mocks in production** - All buttons/interactions call real APIs
3. **Approval gate** - Work orders cannot be claimed until approved
4. **Audit trail** - Log all actions for traceability

## Work Order Lifecycle

```
draft → ready → in_progress → review → done
  │       ↑         ↑           │       ↑
  └─Approve─┘       │           │       │
                  Claim      Complete  Accept
                              ↓
                           Reject → draft
```

| Status | Meaning |
|--------|---------|
| `draft` | Created, awaiting approval |
| `ready` | Approved, available for agents to claim |
| `in_progress` | Claimed by agent, being executed |
| `review` | Completed, awaiting human acceptance |
| `done` | Accepted, finished |
| `blocked` | Halted, needs intervention |

## API Reference

### Work Order Executor
Base: `https://phfblljwuvzqzlbzkzpr.supabase.co/functions/v1/work-order-executor`

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/status` | GET | Get WO counts by status |
| `/poll` | GET | Get ready work orders for claiming |
| `/approve` | POST | Approve draft WO → ready |
| `/claim` | POST | Claim WO for execution → in_progress |
| `/complete` | POST | Mark WO complete → review |
| `/accept` | POST | Accept reviewed WO → done |
| `/reject` | POST | Reject WO with reason → draft |
| `/phase` | POST | Log execution phase |

### Portal APIs
Base: `https://phfblljwuvzqzlbzkzpr.supabase.co/functions/v1`

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/portal-chat` | POST | Send chat messages |
| `/list-threads` | GET | List conversation history |
| `/get-thread` | GET | Fetch thread messages |
| `/workspace-api` | POST | Workspace operations (get_events, etc.) |

### Supabase REST
Base: `https://phfblljwuvzqzlbzkzpr.supabase.co/rest/v1`

| Table | Operations |
|-------|------------|
| `/work_orders` | CRUD for work orders |
| `/agents` | Agent registry |

**Auth:**
- `anon` key: Client-side reads (exposed in frontend)
- `service_role` key: Admin operations (server-side only, from env)

## Database Schema

**work_orders:**
`id`, `slug`, `name`, `objective`, `status`, `priority`, `assigned_to`, `created_by`, `acceptance_criteria`, `tags`, `approved_at`, `created_at`, `updated_at`

**agents:**
`id`, `name`, `description`, `agent_type` (leader/executor/reviewer/specialist), `status`

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Vanilla HTML/CSS/JS (no build system) |
| UI Framework | React 18 (UMD/CDN in workspace.html) |
| Markdown | marked.js |
| Syntax Highlighting | Prism.js (VS Code dark theme) |
| Backend | Supabase Edge Functions + PostgreSQL |
| Deployment | Vercel (static) |

## Key Components

### Chat Portal (`index.html`)

| Function | Purpose |
|----------|---------|
| `send()` | Submit message to portal-chat API |
| `renderMessage()` | Markdown → HTML with Prism highlighting |
| `copyMessage()` / `copyCode()` | Clipboard operations |
| `loadThread()` | Load conversation history |
| `toggleSidebar()` | Mobile navigation |

### Workspace (`workspace.html`)

| Component | Purpose |
|-----------|---------|
| `App` | Main container, state management |
| `KanbanColumn` | Droppable column with drag-over styling |
| `WorkOrderCard` | Draggable card with Approve/Accept/Reject |
| `AgentItem` | Agent status in sidebar |
| `CreateModal` | Work order creation form |
| `Toast` | Notification system |

## Design System

```css
/* Backgrounds - Warm Charcoal */
--bg-primary: #2b2a27;
--bg-surface: #353432;
--bg-elevated: #3f3e3b;

/* Text - Soft White */
--text-primary: #ececec;
--text-secondary: #b8b8b6;
--text-muted: #888886;

/* Accent - Gold */
--accent: #d4a574;

/* Status */
--status-done: #34D399;
--status-blocked: #F87171;
--status-progress: #FBBF24;
--status-review: #A78BFA;

/* Priority */
--priority-critical: #EF4444;
--priority-high: #F97316;
--priority-medium: #EAB308;
--priority-low: #22C55E;
```

**Typography:** Inter (primary), SF Mono/Fira Code (monospace), 14px base

**Breakpoints:** 1200px (hide feed), 900px (narrow sidebar), 768px (mobile stack)

## Development

### Adding Features

1. **API calls**: Use `api()` or `workspaceApi()` helpers in workspace.html
2. **Styles**: Add to `<style>` block using CSS custom properties
3. **Components**: Add React components before `App` in workspace.html

### Adding Prism Languages

```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-{lang}.min.js"></script>
```

### Adding Work Order Status

1. Add to `COLUMNS` array in workspace.html
2. Add `.column-dot.{status}` CSS color
3. Update Supabase enum if using constraints

## Communication Style

**Always end with actionable choices.** Never just report findings - provide recommendations with clear options.

### Response Format

For audits, analysis, or exploration:
1. **Summary** - What was found
2. **Prioritized issues** - Table or list ranked by impact
3. **Recommended action** - Your best suggestion
4. **Options** - 2-3 choices (A/B/C) for user to pick

### Examples

Bad:
> "Here's what I found: [list of issues]"

Good:
> "Here's what I found: [list]. I recommend fixing X first because it blocks Y.
>
> **Options:**
> - A) Fix X now (recommended)
> - B) Fix Y first, then X
> - C) Fix all in one PR"

### Decision Points

**Ask before:**
- Making architectural changes
- Deleting or removing code
- Multiple valid approaches exist (present tradeoffs)

**Clarify when:**
- Intent is uncertain (limit to 2 questions max)

### Don't

- Give long reports without next steps
- Make major changes without confirmation
- Present options without a recommendation
- Ask more than 2 questions at once

## Testing

All interactions must call real Supabase endpoints. Manual checklist:
- [ ] Chat send/receive
- [ ] Markdown + code highlighting
- [ ] Copy buttons
- [ ] Drag-drop work orders
- [ ] Approve → Claim → Complete → Accept flow
- [ ] Reject returns to draft
- [ ] Mobile responsive
- [ ] Toast notifications
