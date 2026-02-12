-- Migration: Fix bulk resolution auto-close bug
-- WO: WO-0470
-- Issue: recheck_auto_close_on_findings_resolved exits early when >2 findings 
--        share same resolved_at, preventing auto-close from running
-- Fix: Replace bulk count guard with precise check for OTHER unresolved fail findings

CREATE OR REPLACE FUNCTION public.recheck_auto_close_on_findings_resolved()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_wo record;
  v_item jsonb;
  v_all_pass boolean := true;
  v_blocking_count int := 0;
BEGIN
  -- Prevent recursive triggers
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  -- Only act on new resolutions
  IF OLD.resolved_at IS NOT NULL OR NEW.resolved_at IS NULL THEN
    RETURN NEW;
  END IF;

  -- Get WO details
  SELECT id, status, qa_checklist, slug
  INTO v_wo
  FROM work_orders
  WHERE id = NEW.work_order_id;

  -- Only auto-close WOs in review
  IF v_wo.status != 'review' THEN
    RETURN NEW;
  END IF;

  -- Require qa_checklist to exist
  IF v_wo.qa_checklist IS NULL OR jsonb_array_length(v_wo.qa_checklist) = 0 THEN
    RETURN NEW;
  END IF;

  -- Check if all checklist items are pass/na
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_wo.qa_checklist)
  LOOP
    IF v_item->>'status' NOT IN ('pass', 'na') THEN
      v_all_pass := false;
      EXIT;
    END IF;
  END LOOP;

  -- Exit if checklist not all pass/na
  IF NOT v_all_pass THEN
    RETURN NEW;
  END IF;

  -- FIXED: Check if ANY OTHER unresolved fail findings remain
  -- This replaces the faulty bulk resolution guard that blocked legitimate auto-close
  -- Old logic: IF v_bulk_count > 2 THEN RETURN NEW; END IF;
  -- New logic: Check if other fail findings exist after this one resolves
  SELECT count(*) INTO v_blocking_count
  FROM qa_findings
  WHERE work_order_id = NEW.work_order_id
    AND finding_type = 'fail'
    AND resolved_at IS NULL
    AND id != NEW.id;  -- Exclude current finding being resolved

  -- If other fail findings exist, don't auto-close yet
  IF v_blocking_count > 0 THEN
    RETURN NEW;
  END IF;

  -- All conditions met: auto-close the WO
  -- This bypass is legitimate - the trigger IS the enforcement mechanism
  PERFORM set_config('app.wo_executor_bypass', 'true', true);

  UPDATE work_orders
  SET status = 'done',
      completed_at = NOW(),
      summary = COALESCE(NULLIF(summary, ''), 'Auto-closed: all QA checklist items passed after findings resolved')
  WHERE id = v_wo.id;

  INSERT INTO work_order_execution_log (work_order_id, phase, agent_name, detail)
  VALUES (v_wo.id, 'execution_complete', 'qa-gate',
    jsonb_build_object(
      'event_type', 'auto_close_qa_pass',
      'content', format('Auto-closed %s: all checklist items passed, no fail findings remain', v_wo.slug),
      'trigger', 'recheck_auto_close_on_findings_resolved'
    )
  );

  RETURN NEW;
END;
$function$;

-- Update function comment
COMMENT ON FUNCTION recheck_auto_close_on_findings_resolved() IS 
'Trigger function to auto-close review WOs when all fail findings are resolved and checklist is pass/na. 
Fixed WO-0470: Removed faulty bulk resolution guard that blocked auto-close when >2 findings shared same resolved_at. 
Now checks if OTHER unresolved fail findings exist - precise and handles bulk resolutions correctly.';
