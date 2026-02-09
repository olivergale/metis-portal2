-- WO-0187: Add checkpoint and continuation phases to work_order_execution_log
-- Adds 'checkpoint' and 'continuation' as valid phase values

-- Drop existing phase constraint if it exists
ALTER TABLE work_order_execution_log
DROP CONSTRAINT IF EXISTS work_order_execution_log_phase_check;

-- Add updated constraint including checkpoint and continuation
ALTER TABLE work_order_execution_log
ADD CONSTRAINT work_order_execution_log_phase_check
CHECK (phase IN (
  'execution_start',
  'stream',
  'execution_complete',
  'failed',
  'velocity_check',
  'checkpoint',
  'continuation',
  'stuck_detection',
  'orphan_cleanup',
  'failed_retry',
  'escalation'
));

-- Add comment documenting the change
COMMENT ON CONSTRAINT work_order_execution_log_phase_check ON work_order_execution_log IS
'WO-0187: Valid phase values including checkpoint (progress save) and continuation (resume after checkpoint)';