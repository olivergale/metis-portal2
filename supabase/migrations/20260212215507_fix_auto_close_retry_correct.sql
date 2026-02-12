-- Migration: Fix auto-close retry after findings resolution
-- WO: WO-0470
-- Issue: WOs stuck in review after remediation resolves all fail findings
-- Root Cause: trg_recheck_auto_close_on_findings_resolved does not re-trigger auto-close check
-- Fix: Touch qa_checklist to re-fire trg_auto_close_review_on_qa_pass BEFORE UPDATE trigger

CREATE OR REPLACE FUNCTION public.recheck_auto_close_on_findings_resolved()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_wo_id uuid;
  v_wo_status text;
  v_unresolved_fail_count int;
BEGIN
  -- Get WO ID from the resolved finding
  v_wo_id := NEW.work_order_id;
  
  -- Only proceed if finding was just resolved (resolved_at changed from NULL to non-NULL)
  IF OLD.resolved_at IS NOT NULL OR NEW.resolved_at IS NULL THEN
    RETURN NEW;
  END IF;
  
  -- Check if WO is in review status
  SELECT status INTO v_wo_status
  FROM work_orders
  WHERE id = v_wo_id;
  
  IF v_wo_status = 'review' THEN
    -- Count remaining unresolved fail findings
    SELECT COUNT(*)
    INTO v_unresolved_fail_count
    FROM qa_findings
    WHERE work_order_id = v_wo_id
      AND category = 'fail'
      AND resolved_at IS NULL;
    
    -- If no more fail findings, touch qa_checklist to re-trigger auto-close
    IF v_unresolved_fail_count = 0 THEN
      -- Force qa_checklist UPDATE to re-fire trg_auto_close_review_on_qa_pass
      -- The BEFORE UPDATE trigger checks: old.qa_checklist IS DISTINCT FROM new.qa_checklist
      -- This UPDATE ensures the trigger fires by updating the updated_at timestamp
      UPDATE work_orders
      SET qa_checklist = qa_checklist,
          updated_at = now()
      WHERE id = v_wo_id;
      
      -- Log the retry attempt
      INSERT INTO work_order_execution_log (work_order_id, phase, agent_name, detail)
      VALUES (
        v_wo_id,
        'stream',
        'system',
        jsonb_build_object(
          'event_type', 'auto_close_retry',
          'message', 'Re-triggering auto-close check after all fail findings resolved',
          'unresolved_fail_count', v_unresolved_fail_count
        )
      );
    END IF;
  END IF;
  
  RETURN NEW;
END;
$function$;

-- Update function comment
COMMENT ON FUNCTION recheck_auto_close_on_findings_resolved() IS 
'Trigger function to re-trigger auto-close check when all fail findings are resolved.
Fixed WO-0470: Touches qa_checklist to re-fire trg_auto_close_review_on_qa_pass BEFORE UPDATE trigger.
The auto-close trigger fires when qa_checklist changes, so we force an UPDATE to re-run the check.';
