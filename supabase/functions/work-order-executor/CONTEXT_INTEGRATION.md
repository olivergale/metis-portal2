# Repository Context Integration Guide

## Overview
The `context.ts` module provides code-aware context loading for the builder agent by reading the GitHub repository tree and injecting relevant file paths into the system prompt.

## Usage

### 1. Import the functions
```typescript
import { loadRepoContext, injectRepoContext } from './context.ts';
```

### 2. Load repo context for a work order
```typescript
// In your prompt building function (e.g., buildBuilderPrompt)
const workOrder = { 
  tags: ['supabase', 'edge-function'], 
  objective: 'Deploy new endpoint',
  name: 'Add status endpoint'
};

// Load context (returns null if WO doesn't involve code)
const repoContext = await loadRepoContext(workOrder);
```

### 3. Inject into system prompt
```typescript
let systemPrompt = buildBasePrompt(); // Your existing prompt builder

// Inject repo context before SYSTEM CONTEXT section
systemPrompt = injectRepoContext(systemPrompt, repoContext);
```

## What Gets Loaded

The context loader filters the repo tree and categorizes files:

- **Edge Functions**: All `supabase/functions/*/index.ts` files (up to 30 shown)
- **Database Migrations**: All `.sql` files in `supabase/migrations/` (last 10 shown)
- **Frontend Components**: TypeScript/TSX files in `src/components/` (up to 20 shown)
- **Key Source Files**: Files in `src/pages/`, `src/hooks/`, `src/utils/`, `src/lib/`
- **Config Files**: `package.json`, `tsconfig.json`, `vite.config.ts`, `supabase/config.toml`

## When Context is Loaded

Context loading is **conditional** based on work order characteristics:

### Code-Related Tags (triggers loading):
- `supabase`
- `migration`
- `schema`
- `edge-function`
- `frontend`
- `portal-frontend`
- `deployment`
- `rollback`

### Code-Related Keywords in objective/name (triggers loading):
- deploy, function, migration, schema, edge
- frontend, component, api, endpoint
- table, rpc, trigger

If neither tags nor keywords match, `loadRepoContext()` returns `null` and no context is added.

## Output Format

The injected context appears as a markdown section:

```markdown
# CODEBASE CONTEXT

## Edge Functions
Available edge functions in `supabase/functions/`:
- work-order-executor/index.ts
- context-load/index.ts
- portal-chat/index.ts
- ... (25 more)

## Database Migrations
Migration files in `supabase/migrations/`:
- 20260209000000_add_execution_rank.sql
- 20260208000000_add_qa_checklist.sql
- ... (8 older migrations)

## Frontend Components
Key components in `src/components/`:
- WorkOrderCard.tsx
- AgentSelector.tsx
- ... (18 more)

## Key Source Files
- hooks/useWorkOrders.ts
- utils/supabase.ts
- package.json
- tsconfig.json

**Note**: Use `github_read_file` to read specific files. Paths are relative to repo root (olivergale/metis-portal2).
```

## Integration Example

```typescript
async function executeWorkOrder(workOrderId: string) {
  // Fetch work order
  const { data: wo } = await supabase
    .from('work_orders')
    .select('*')
    .eq('id', workOrderId)
    .single();

  // Load repo context
  const repoContext = await loadRepoContext(wo);
  
  // Build base prompt
  let systemPrompt = `# WORKER AGENT IDENTITY
You are builder, executing WO-${wo.slug}...

# SYSTEM CONTEXT
Recent changes: ...
`;

  // Inject repo context (appears before SYSTEM CONTEXT)
  systemPrompt = injectRepoContext(systemPrompt, repoContext);
  
  // Use prompt in Claude API call
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    system: systemPrompt,
    messages: [...]
  });
}
```

## Error Handling

The functions gracefully handle errors:
- Missing GitHub token → logs warning, returns `null`
- GitHub API errors → logs warning, returns `null`  
- Network failures → logs error, returns `null`

If context loading fails, the prompt builder continues without repo context (no disruption to WO execution).

## Environment Requirements

Requires `GITHUB_TOKEN` environment variable with repo read access:
- Set in Supabase Edge Function secrets
- Must have `repo` or `public_repo` scope
- Used for GitHub API authentication

## Performance

- GitHub tree API call: ~200-500ms
- Tree parsing: ~10-50ms (depends on repo size)
- Total overhead: <1 second per WO execution
- Only called once per WO (not per Claude turn)

## Future Enhancements

Potential improvements:
1. Cache repo tree for 5-10 minutes (reduce API calls)
2. Smart file selection based on WO objective keywords
3. Include file sizes to help prioritize which files to read
4. Add support for monorepo subpath filtering
