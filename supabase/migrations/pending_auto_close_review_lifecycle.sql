-- WO-0370: Add evaluate_wo_lifecycle call to auto_close_review_on_qa_pass
-- This function is a BEFORE UPDATE trigger and uses set_config for bypass (existing pattern)

CREATE OR REPLACE FUNCTION public.auto_close_review_on_qa_pass()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  v_item jsonb;
  v_all_pass boolean := true;
  v_has_items boolean := false;
  v_lifecycle_verdict JSONB;
BEGIN
  -- Only act on review WOs with a checklist update
  IF NEW.status != 'review' THEN
    RETURN NEW;
  END IF;
  
  -- Only act if qa_checklist actually changed
  IF OLD.qa_checklist IS NOT DISTINCT FROM NEW.qa_checklist THEN
    RETURN NEW;
  END IF;
  
  -- Check if all checklist items are pass or na (none pending/fail)
  IF NEW.qa_checklist IS NULL OR jsonb_array_length(NEW.qa_checklist) = 0 THEN
    RETURN NEW;
  END IF;
  
  FOR v_item IN SELECT * FROM jsonb_array_elements(NEW.qa_checklist)
  LOOP
    v_has_items := true;
    IF v_item->>'status' NOT IN ('pass', 'na') THEN
      v_all_pass := false;
      EXIT;
    END IF;
  END LOOP;
  
  IF v_has_items AND v_all_pass THEN
    -- WO-0370: Call evaluate_wo_lifecycle for logging
    v_lifecycle_verdict := evaluate_wo_lifecycle(NEW.id, 'qa_verdict', jsonb_build_object('transition', 'qa_pass'));
    
    -- Log verdict
    INSERT INTO work_order_execution_log (work_order_id, phase, agent_name, detail)
    VALUES (NEW.id, 'stream', 'system',
      jsonb_build_object(
        'event_type', 'lifecycle_gate_check',
        'action', 'qa_pass',
        'verdict', v_lifecycle_verdict
      )
    );
    
    -- Use set_config to transition review → done (existing pattern in trigger)
    PERFORM set_config('app.wo_executor_bypass', 'true', true);
    NEW.status := 'done';
    NEW.completed_at := NOW();
    IF NEW.summary IS NULL OR NEW.summary = '' THEN
      NEW.summary := 'Auto-closed: all QA checklist items passed';
    END IF;
    
    -- Log the auto-close
    INSERT INTO work_order_execution_log (work_order_id, phase, agent_name, detail)
    VALUES (NEW.id, 'execution_complete', 'qa-gate',
      jsonb_build_object(
        'event_type', 'auto_close_qa_pass',
        'content', format('Auto-closed %s: all %s checklist items passed', NEW.slug, jsonb_array_length(NEW.qa_checklist)),
        'checklist_items', jsonb_array_length(NEW.qa_checklist)
      )
    );
  END IF;
  
  RETURN NEW;
END;
$function$;
