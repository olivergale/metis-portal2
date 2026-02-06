# ENDGAME-001 State Machine
*Auto-generated from live system state at 2026-02-06 18:25:31.187931+00*
*Frontend implementation added: 2026-02-06 20:20:00+00*

## WO Lifecycle
```
draft -> ready -> in_progress -> review -> done
             \-> cancelled                  |
in_progress -> blocked -> in_progress      | (administrative rollback)
blocked -> draft                           v
cancelled <--------------------------------+
cancelled -> draft
```

## Valid Transitions
| From | To |
|------|-----|
| draft | ready, cancelled |
| ready | in_progress, cancelled |
| pending_approval | ready, cancelled |
| in_progress | review, done, blocked, cancelled |
| blocked | in_progress, draft, cancelled |
| review | done, in_progress, cancelled |
| done | cancelled (administrative rollback only) |
| cancelled | draft |

## Preconditions
- **ready**: name, objective, assigned_to required
- **in_progress**: approval required if requires_approval=true
- **Intake gate**: project intake must be complete for project-scoped WOs

## Auto-Approval Path
```
WO created (draft) -> auto_approve_evaluation trigger
  -> score_work_order_risk() -> risk score
  -> evaluate_auto_approval() -> approve/deny/dry_run
  -> If approved: start_work_order() atomic
  -> Daemon picks up -> executes -> completes
```

## Enforcement
- validate_wo_transition() checks all transitions
- Rejections logged to audit_log as wo_transition_rejected
- Doc currency soft gate on in_progress->review transition
- **Administrative Rollback**: done→cancelled requires:
  1. Cancellation reason in summary field
  2. Original completion data preserved in client_info
  3. Audit log entry with administrative_rollback event type
