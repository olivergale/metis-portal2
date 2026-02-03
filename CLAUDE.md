# CLAUDE.md - METIS Portal Codebase Guide

## Overview

METIS Portal is a web-based AI orchestration platform consisting of two main interfaces:
- **Chat Portal** (`index.html`) - Conversational AI interface with markdown rendering
- **Workspace** (`workspace.html`) - Kanban-style task management for AI agents

## Architecture

### Technology Stack

| Layer | Technology |
|-------|------------|
| Frontend | Vanilla HTML/CSS/JS (no build system) |
| UI Framework | React 18 (UMD/CDN in workspace.html only) |
| Markdown | marked.js |
| Syntax Highlighting | Prism.js (VS Code dark theme colors) |
| Backend | Supabase (Edge Functions + PostgreSQL) |
| Transpilation | Babel standalone (for JSX in workspace.html) |

### File Structure

```
metis-portal2/
├── index.html       # Chat interface (METIS Portal)
├── workspace.html   # Kanban board (Endgame Workspace)
├── CLAUDE.md        # This file
└── .git/            # Git repository
```

## Backend Integration

### Supabase Configuration

- **Project URL**: `https://phfblljwuvzqzlbzkzpr.supabase.co`
- **Auth**: Anonymous key (public, read-heavy operations)

### API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/functions/v1/portal-chat` | POST | Send chat messages |
| `/functions/v1/list-threads` | GET | List conversation history |
| `/functions/v1/get-thread` | GET | Fetch thread messages |
| `/functions/v1/workspace-api` | POST | Workspace operations |
| `/functions/v1/work-order-executor/approve` | POST | Approve work orders |
| `/functions/v1/work-order-executor/accept` | POST | Accept completed work |
| `/functions/v1/work-order-executor/reject` | POST | Reject work orders |
| `/rest/v1/work_orders` | REST | Work order CRUD |
| `/rest/v1/agents` | REST | Agent registry |

### Database Schema (Inferred)

**work_orders**:
- `id`, `slug`, `name`, `objective`, `status`, `priority`
- `assigned_to`, `created_by`, `acceptance_criteria`, `tags`
- `approved_at`, `created_at`, `updated_at`

**agents**:
- `id`, `name`, `description`, `agent_type`, `status`

## Design System

### Color Tokens (CSS Custom Properties)

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
--accent-hover: #e0b588;

/* Status Colors */
--status-inbox: #9CA3AF;
--status-assigned: #60A5FA;
--status-progress: #FBBF24;
--status-review: #A78BFA;
--status-done: #34D399;
--status-blocked: #F87171;

/* Priority Colors */
--priority-critical: #EF4444;
--priority-high: #F97316;
--priority-medium: #EAB308;
--priority-low: #22C55E;
```

### Typography

- **Primary Font**: Inter, system fonts fallback
- **Monospace**: SF Mono, Fira Code
- **Base Size**: 14px

## Key Components

### index.html (Chat Portal)

1. **Sidebar** - Conversation history list
2. **Chat Container** - Message thread display
3. **Input Area** - Message composition with auto-resize
4. **Message Rendering** - Markdown with syntax highlighting

**Important Functions**:
- `send()` - Submit messages to API
- `renderMessage()` - Convert message to HTML with markdown
- `copyMessage()` / `copyCode()` - Clipboard operations
- `loadThread()` - Load conversation history
- `toggleSidebar()` - Mobile navigation

### workspace.html (Kanban Board)

**React Components**:
- `App` - Main container with state management
- `KanbanColumn` - Droppable column with drag-over styling
- `WorkOrderCard` - Draggable task card with actions
- `AgentItem` - Agent status display
- `EventItem` - Activity feed entry
- `CreateModal` - Work order creation form
- `Toast` - Notification system

**Kanban Columns**:
1. Inbox (draft)
2. Assigned (ready)
3. In Progress (in_progress)
4. Review (review)
5. Done (done)
6. Blocked (blocked)

## Development Guidelines

### Code Style

- **No build system** - Files are served directly
- **Single-file components** - All CSS/JS inline in HTML
- **CSS Custom Properties** - Use design tokens, not hardcoded colors
- **ES6+** - Modern JavaScript, async/await for API calls

### Adding Features

1. **New API calls**: Add to the `api()` or `workspaceApi()` helper functions
2. **New styles**: Add to the `<style>` block, following BEM-lite naming
3. **New components**: For workspace.html, add React components before `App`

### Responsive Breakpoints

- **1200px**: Hide feed sidebar
- **900px**: Reduce sidebar width
- **768px**: Hide agents sidebar, stack mobile layout

## Approval Workflow

Work orders follow this lifecycle:

```
draft → [Approve] → ready → [Claim] → in_progress → [Submit] → review → [Accept/Reject] → done/draft
```

- **Approve**: Human approves work order for agent execution
- **Accept**: Human accepts completed work
- **Reject**: Human rejects and returns to draft with feedback

## Security Notes

- Supabase anon key is exposed (intentional for public read access)
- Sensitive operations should use RLS (Row Level Security) in Supabase
- No authentication currently implemented in frontend

## Common Tasks

### Add a new work order status

1. Add to `COLUMNS` array in workspace.html
2. Add CSS for `.column-dot.{status}` color
3. Update Supabase enum if using database constraints

### Modify syntax highlighting

Prism.js components are loaded via CDN. To add languages:
```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-{language}.min.js"></script>
```

### Update theme colors

Modify CSS custom properties in `:root`. Both files share the same color palette for consistency.

## Testing

No automated tests. Manual testing checklist:
- [ ] Chat message send/receive
- [ ] Markdown rendering (headers, code, lists, tables)
- [ ] Code copy functionality
- [ ] Drag-and-drop work orders
- [ ] Approve/Accept/Reject workflows
- [ ] Mobile responsive layout
- [ ] Toast notifications

## Deployment

Static files can be served from any web server or CDN. No build step required.

Ensure Supabase edge functions are deployed and CORS is configured to allow the hosting domain.
