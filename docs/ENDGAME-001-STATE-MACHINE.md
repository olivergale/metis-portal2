# ENDGAME-001 State Machine Reference

> WO lifecycle, enforcement layer, and routing rules.
> Source: `validate_wo_transition()`, `enforce_wo_state_changes()`, `auto_route_work_order()`.
> Last updated: 2026-02-06

## Work Order State Graph

```
                    ┌──────────┐
                    │  draft   │
                    └────┬─────┘
                         │
                    ┌────▼─────┐      ┌───────────────┐
                    │  ready   │◄─────│pending_approval│
                    └────┬─────┘      └───────────────┘
                         │
                    ┌────▼──────┐
              ┌─────│in_progress│─────┐
              │     └─────┬─────┘     │
              │           │           │
         ┌────▼───┐  ┌───▼────┐  ┌───▼────┐
         │blocked │  │ review │  │  done  │
         └────┬───┘  └───┬────┘  └────────┘
              │          │
              │     ┌────▼───┐
              └────►│  done  │
                    └────────┘

    Any state ──────► cancelled
    cancelled ──────► draft (reopen)
    blocked ────────► in_progress | draft (unblock)
    review ─────────► done | in_progress (rework)
```

## Valid Transitions

| From | To (allowed) |
|------|-------------|
| `draft` | `ready`, `cancelled` |
| `ready` | `in_progress`, `cancelled` |
| `pending_approval` | `ready`, `cancelled` |
| `in_progress` | `review`, `done`, `blocked`, `cancelled` |
| `blocked` | `in_progress`, `draft`, `cancelled` |
| `review` | `done`, `in_progress`, `cancelled` |
| `done` | (terminal — no transitions) |
| `cancelled` | `draft` (reopen only) |

## Preconditions per Target Status

### → `ready`
- `name` must be non-null and non-empty
- `objective` must be non-null and non-empty
- `assigned_to` must be non-null (agent must be assigned)
- If `project_brief_id` is set, project intake must be complete

### → `in_progress`
- If `requires_approval = true`, then `approved_at` must be non-null
- If `project_brief_id` is set, project intake must be complete

### → All other states
- No additional preconditions beyond valid transition path

## Enforcement Layer

### Trigger: `enforce_wo_state_changes` (BEFORE UPDATE on work_orders)

Protected columns:
- `status`
- `approved_at`
- `approved_by`
- `started_at`
- `completed_at`

**Without bypass**: Any change to these columns raises an exception:
> "Direct work order state changes blocked. Use METIS Portal or work-order-executor API."

**With bypass** (`app.wo_executor_bypass = 'true'`):
- Transition is still validated via `validate_wo_transition()`
- Invalid transitions are rejected even with bypass active

Bypass is set by:
- `update_work_order_state()` RPC
- `state_write()` RPC (via `app.state_write_bypass`)

### Trigger: `enforce_state_write` (BEFORE INSERT on system_manifest, decisions, schema_changes)

Checks `app.state_write_bypass` session variable. Without it, direct inserts are blocked.
All writes must go through `state_write()` RPC.

### Trigger: `audit_log_immutable` (BEFORE DELETE on audit_log)

Unconditional — no bypass available. Audit log cannot be deleted.

### Trigger: `enforce_append_only` (BEFORE DELETE on spans, traces, trace_events)

Unconditional — no bypass. Observability data is append-only.

## RPCs for State Changes

### `update_work_order_state(p_work_order_id, p_status, ...)`
- SECURITY DEFINER
- Sets `app.wo_executor_bypass = 'true'` for the transaction
- Updates status and timestamp columns
- Trigger still validates the transition

### `start_work_order(p_work_order_id, p_agent_name)`
- SECURITY DEFINER
- Atomic operation: assign agent → set approved → step through draft→ready→in_progress
- Used by `wo start` CLI and daemon

### `state_write(p_mutation_type, p_target_table, p_payload, ...)`
- SECURITY INVOKER (but calls DEFINER functions internally)
- Logs mutation to `state_mutations` table with previous state capture
- Sets bypass flag for enforcement triggers
- Validates WO if `p_work_order_id` provided
- Protected tables require a WO: `system_manifest`, `work_orders`, `decisions`, `schema_changes`

### `create_draft_work_order(p_name, p_slug, p_objective, ...)`
- SECURITY DEFINER
- Creates WO in `draft` status
- No WO context required (bootstrap function)
- **Param order**: `p_name` first, then `p_slug` (despite misleading names in some versions)

## Auto-Routing Rules

### Trigger: `auto_route_work_order` (BEFORE UPDATE on work_orders)

Fires when: status changes TO `ready` AND `assigned_to` IS NULL.

Routing logic:
1. Tags contain `review`, `audit`, or `security-review` → assign to `audit` agent
2. All other WOs → assign to `ilmarinen` (executor fallback)

Logs routing decision to `state_mutations`.

### Edge Function: `work-order-executor` /approve handler

Pre-assignment before state transition (added in v13):
- Uses same logic as trigger: review/audit/security tags → audit, else → ilmarinen
- Assigns agent BEFORE calling `update_work_order_state()` to satisfy `assigned_to` precondition

**Note**: Both the trigger and the edge function implement routing. The edge function assigns first (to satisfy preconditions), then the trigger skips (already assigned). This is intentional redundancy.

### Trigger: `autoroute_new_wo` (AFTER INSERT on work_orders)

Fires on new WO creation. Calls `trigger_autoroute_new_wo()` which runs `autoroute_work_order()` RPC.

## Transition Rejection Logging

Failed transitions are logged to `audit_log`:
- `event_type`: `wo_transition_rejected`
- `actor_type`: `system`
- `actor_id`: `validate_wo_transition`
- `payload`: `{ errors: [...], wo_slug: "..." }`
- `previous_state`: `{ status: "old" }`
- `new_state`: `{ status: "attempted" }`

## Common Transition Sequences

### Manual (via wo CLI)
```
wo create "Name" "Objective" priority    → draft
wo start SLUG                            → draft→ready→in_progress (atomic)
[agent executes]
wo review SLUG "summary"                 → in_progress→review
wo done SLUG                             → review→done
```

### Portal-initiated
```
intake-api creates draft WO              → draft
workspace UI clicks Approve              → work-order-executor /approve
  → auto-assign agent                    → (assigned_to set)
  → update_work_order_state(ready)       → draft→ready
daemon polls → claims → executes         → ready→in_progress
daemon completes                         → in_progress→review (or done)
```

### Self-improvement loop
```
error span created                       → trg_auto_lesson_on_error_span → lesson created
lesson-promoter cron                     → detect_lesson_gaps() finds pattern
auto_create_gap_wo()                     → draft WO with self-update tags
```
