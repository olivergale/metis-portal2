# ENDGAME-001 State Machine
*Auto-generated from live system state at 2026-02-06 18:25:31.187931+00*

## WO Lifecycle
```
draft -> ready -> in_progress -> review -> done
             \-> cancelled
in_progress -> blocked -> in_progress
blocked -> draft
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
| done | (terminal) |
| cancelled | draft |

## Preconditions
- **ready**: name, objective, assigned_to required
- **in_progress**: approval required if requires_approval=true
- **done** (from in_progress): deployment validation gate for deployment-tagged WOs
  - Validates required environment variables exist in secrets table
  - Checks build status from execution logs (must be 'success')
  - Scans deployment logs for critical errors (must be zero)
  - Can be bypassed with skip_deploy_validation flag
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
- **Deployment validation gate** (v24 - deployed 2026-02-07): Integrated into validate_wo_transition()
  - Automatically triggered on in_progress->done or in_progress->review transitions
  - Checks WOs with 'deployment' or 'deploy' tags, or deployed_functions/schema_changes in client_info
  - Calls validate_deployment_readiness() RPC to verify:
    - Environment variables exist in secrets table
    - Build status from execution logs (must be 'success')
    - Deployment logs have zero critical errors
  - Blocks transition if validation fails
  - Logs validation results to work_order_execution_log as 'deployment_validation' phase
  - Creates lesson on validation failure for self-improvement
  - Can be bypassed with skip_deploy_validation flag in client_info
