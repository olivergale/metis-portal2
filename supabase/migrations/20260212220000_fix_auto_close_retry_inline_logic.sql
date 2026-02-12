-- Migration: Fix auto-close retry after findings resolution - inline auto-close logic
-- WO: WO-0470
-- Issue: Touching qa_checklist doesn't work because IS NOT DISTINCT FROM compares values
-- Fix: Inline the auto-close logic directly in recheck trigger instead of trying to re-fire other trigger

CREATE OR REPLACE FUNCTION public.recheck_auto_close_on_findings_resolved()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_wo record;
  v_item jsonb;
  v_all_pass boolean := true;
  v_has_items boolean := false;
  v_unresolved_fail_count int;
BEGIN
  -- Only proceed if finding was just resolved (resolved_at changed from NULL to non-NULL)
  IF OLD.resolved_at IS NOT NULL OR NEW.resolved_at IS NULL THEN
    RETURN NEW;
  END IF;
  
  -- Load the work order with its checklist
  SELECT id, slug, status, qa_checklist, summary
  INTO v_wo
  FROM work_orders
  WHERE id = NEW.work_order_id;
  
  -- Only act on review WOs
  IF v_wo.status != 'review' THEN
    RETURN NEW;
  END IF;
  
  -- Must have a checklist
  IF v_wo.qa_checklist IS NULL OR jsonb_array_length(v_wo.qa_checklist) = 0 THEN
    RETURN NEW;
  END IF;
  
  -- Check all checklist items are pass or na
  FOR v_item IN SELECT * FROM jsonb_array_elements(v_wo.qa_checklist)
  LOOP
    v_has_items := true;
    IF v_item->>'status' NOT IN ('pass', 'na') THEN
      v_all_pass := false;
      EXIT;
    END IF;
  END LOOP;
  
  -- If not all pass, exit
  IF NOT (v_has_items AND v_all_pass) THEN
    RETURN NEW;
  END IF;
  
  -- Count remaining unresolved fail findings (excluding the one we just resolved)
  SELECT COUNT(*)
  INTO v_unresolved_fail_count
  FROM qa_findings
  WHERE work_order_id = v_wo.id
    AND finding_type = 'fail'
    AND resolved_at IS NULL
    AND id != NEW.id;
  
  -- If there are still fail findings, exit
  IF v_unresolved_fail_count > 0 THEN
    RETURN NEW;
  END IF;
  
  -- All conditions met: auto-close the WO using update_work_order_state RPC
  -- (The RPC handles bypass and enforcement checks internally)
  DECLARE
    v_transition_result jsonb;
  BEGIN
    SELECT update_work_order_state(
      p_work_order_id := v_wo.id,
      p_status := 'done',
      p_completed_at := NOW(),
      p_summary := COALESCE(NULLIF(v_wo.summary, ''), 'Auto-closed: all QA checklist items passed after findings resolved')
    ) INTO v_transition_result;
    
    -- Log the auto-close
    INSERT INTO work_order_execution_log (work_order_id, phase, agent_name, detail)
    VALUES (
      v_wo.id,
      'execution_complete',
      'qa-gate',
      jsonb_build_object(
        'event_type', 'auto_close_qa_pass',
        'message', format('Auto-closed %s: all %s checklist items passed, last fail finding resolved', v_wo.slug, jsonb_array_length(v_wo.qa_checklist)),
        'trigger', 'recheck_auto_close_on_findings_resolved',
        'checklist_items', jsonb_array_length(v_wo.qa_checklist),
        'rpc_result', v_transition_result
      )
    );
  END;
  
  RETURN NEW;
END;
$function$;

-- Update function comment
COMMENT ON FUNCTION recheck_auto_close_on_findings_resolved() IS 
'Trigger function to re-run auto-close check when fail findings are resolved.
Fixed WO-0470: Inlines auto-close logic directly instead of trying to re-fire trg_auto_close_review_on_qa_pass.
The auto-close trigger uses IS NOT DISTINCT FROM which prevents simple qa_checklist touch from working.';
