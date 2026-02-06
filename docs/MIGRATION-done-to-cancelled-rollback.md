# Migration: Add done→cancelled Administrative Rollback Transition

**Work Order**: WO-ROLLBACK-TRANSITION
**Status**: MIGRATION SPEC (Requires Supabase deployment)
**Created**: 2026-02-06

## Objective

Enable administrative correction of improperly completed work orders by adding a `done→cancelled` transition to the state machine. This allows the system to self-correct when WOs are completed without proper validation (e.g., built without PRD, phantom completions).

## Current State

The state machine makes `done` a terminal state with no outbound transitions:

```
| done | (terminal) |
```

This prevents any correction once a WO reaches `done` status.

## Proposed Changes

### 1. Update State Machine Transitions

Add `done→cancelled` as a valid transition in `validate_wo_transition()` function.

**Location**: Supabase RPC function `update_work_order_state()` or `validate_wo_transition()`

**Change**:
```sql
-- Current transition validation
-- done: [] (no outbound transitions)

-- New transition validation
-- done: [cancelled] (with special gates)
```

### 2. Validation Gates for done→cancelled

The transition must enforce three requirements:

1. **Cancellation Reason Required**: The `summary` field must contain a cancellation reason explaining why the completion was invalid
2. **Audit Logging**: Log the event to `audit_log` table with event type `administrative_rollback`
3. **Data Preservation**: Store original completion data in `client_info` JSONB field before rollback

**Validation Logic**:
```sql
-- Pseudo-code for validation
IF current_status = 'done' AND new_status = 'cancelled' THEN
  -- Check 1: Cancellation reason required
  IF summary IS NULL OR summary = '' THEN
    RAISE EXCEPTION 'Cancellation reason required in summary field for done→cancelled transition';
  END IF;

  -- Check 2: Preserve completion data
  IF client_info->>'original_completion_data' IS NULL THEN
    client_info = jsonb_set(
      client_info,
      '{original_completion_data}',
      jsonb_build_object(
        'completed_at', completed_at,
        'completed_by', completed_by,
        'original_summary', summary,
        'rollback_timestamp', NOW()
      )
    );
  END IF;

  -- Check 3: Audit log entry
  INSERT INTO audit_log (
    event_type,
    work_order_id,
    metadata
  ) VALUES (
    'administrative_rollback',
    work_order_id,
    jsonb_build_object(
      'from_status', 'done',
      'to_status', 'cancelled',
      'reason', summary,
      'actor', current_user_id
    )
  );
END IF;
```

### 3. Update State Machine Documentation

Update `/docs/ENDGAME-001-STATE-MACHINE.md` to reflect the new transition:

```markdown
| done | cancelled (administrative rollback only) |
```

## Implementation Requirements

### Database Changes

1. **RPC Function**: Modify `update_work_order_state()` to handle done→cancelled with special validation
2. **Audit Log**: Ensure `audit_log` table supports `administrative_rollback` event type
3. **Client Info**: Ensure `work_orders.client_info` can store original completion data

### Edge Function Changes

1. **work-order-executor**: Update to support rollback requests from authorized users
2. **evaluate-gates**: May need to add gate for administrative rollback approval

### Frontend Changes

1. **workspace.html**: Add "Rollback Completion" button for `done` WOs (admin only)
2. **Modal**: Require cancellation reason input before allowing rollback

## Testing Checklist

- [ ] Normal done→cancelled transition with reason works
- [ ] done→cancelled without reason is rejected
- [ ] Original completion data is preserved in client_info
- [ ] Audit log entry is created with correct event type
- [ ] Frontend rollback button only shows for done WOs
- [ ] Rollback requires confirmation with reason

## Security Considerations

- **Authorization**: Only admin users or WO creator should be able to rollback completions
- **Rate Limiting**: Consider rate limit on rollback operations to prevent abuse
- **Audit Trail**: All rollbacks must be logged with full context

## Acceptance Criteria

1. ✅ done→cancelled transition is valid in state machine
2. ✅ Cancellation reason is required in summary field
3. ✅ Original completion data preserved in client_info
4. ✅ Audit log entry created with administrative_rollback event type
5. ✅ State machine documentation updated
6. ✅ Frontend UI supports rollback with reason input

## Deployment Notes

**This migration requires Supabase database deployment and cannot be executed from the frontend-only metis-portal2 repository.**

Required deployment steps:
1. Deploy SQL migration to update `update_work_order_state()` RPC function
2. Deploy `work-order-executor` edge function updates
3. Deploy frontend changes to workspace.html
4. Update state machine documentation

## Related Work Orders

- Original request: WO-ROLLBACK-TRANSITION
- Related: Any WO dealing with state machine enforcement
